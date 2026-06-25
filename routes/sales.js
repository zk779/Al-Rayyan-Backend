import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { generateNextSalesInvoiceNo } from "../utils/invoiceNo.js";

const router = express.Router();
const prisma = new PrismaClient();

/* --------------------------- 🔐 AUTH MIDDLEWARE --------------------------- */
async function authenticate(req, res, next) {
	const authHeader = req.headers.authorization;
	if (!authHeader)
		return res.status(401).json({ error: "Missing Authorization header" });

	const token = authHeader.split(" ")[1];
	try {
		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		const user = await prisma.user.findUnique({ where: { id: decoded.id } });
		if (!user || !user.isActive)
			return res.status(401).json({ error: "User inactive or removed" });

		req.user = decoded;
		next();
	} catch (err) {
		return res.status(401).json({ error: "Invalid or expired token" });
	}
}

/* ------------------------------------------------------------------------ */
/* ✅ CREATE SALES (Invoice + Multiple Sales + Vendor Ledger Entries) */
/* ------------------------------------------------------------------------ */
/* ======================= GET ALL INVOICES ======================= */
router.get("/", authenticate, async (req, res) => {
    try {
        const { search } = req.query;

        const whereClause = search ? {
            OR: [
                { invoiceNo: { contains: search, mode: "insensitive" } },
                {
                    sales: {
                        some: {
                            OR: [
                                { documentNo: { contains: search, mode: "insensitive" } },
                                { remarks: { contains: search, mode: "insensitive" } }
                            ]
                        }
                    }
                }
            ]
        } : {};

        const invoices = await prisma.salesInvoice.findMany({
            where: whereClause,
            orderBy: { createdAt: "desc" },
            include: {
                user: { select: { id: true, fullName: true, email: true } },
                sales: {
                    select: {
                        id: true,
                        netPrice: true,
                        sellPrice: true,
                        profit: true,
                        status: true,
                        documentNo: true,
                        paymentType: true,
                        paymentStatus: true,
                        paidAmount: true,
                        customerId: true,
                        remarks: true,
                        pnr: true,
                        paxName: true,
                        vendor: {
                            select: {
                                vendorName: true,
                                category: true,
                                account: { select: { balance: true } }
                            }
                        },
                        airline: { select: { airlineCode: true, airlineName: true } },
                        customer: {
                            select: {
                                customerName: true,
                                phone: true,
                                account: { select: { balance: true } }
                            }
                        },
                        // Changed field name to match your schema's 'refunds'
                        refunds: { 
                            select: { 
                                id: true,
                                status: true, 
                                refundDate: true,
                                netRefundToCustomer: true,
                                vendorRefundAmount: true,
                                refundFee: true,
                                cancellationCharges: true, // Matches your schema
                                refundReason: true,
                                remarks: true,
                                netRefundToCustomer: true
                            } 
                        } 
                    }
                }
            }
        });

        const data = invoices.map(inv => ({
            id: inv.id,
            invoiceNo: inv.invoiceNo,
            saleDate: inv.saleDate,
            createdById: inv.user?.id || null,
            createdByName: inv.user?.fullName || null,
            createdByEmail: inv.user?.email || null,
            totalNet: inv.totalNet,
            totalSell: inv.totalSell,
            totalProfit: inv.totalProfit,
            salesCount: inv.sales.length,
            sales: inv.sales.map(s => ({
                id: s.id,
                documentNo: s.documentNo,
                pnr: s.pnr,
                paxName: s.paxName,
                vendorName: s.vendor?.vendorName || null,
                vendorCategory: s.vendor?.category || null,
                vendorBalance: s.vendor?.account?.balance ?? null,
                airlineCode: s.airline?.airlineCode || null,
                airlineName: s.airline?.airlineName || null,
                paymentType: s.paymentType,
                paymentStatus: s.paymentStatus,
                paidAmount: s.paidAmount,
                customerId: s.customerId || null,
                customerName: s.customer?.customerName || null,
                customerPhone: s.customer?.phone || null,
                customerBalance: s.customer?.account?.balance ?? null,
                netPrice: s.netPrice,
                sellPrice: s.sellPrice,
                profit: s.profit,
                remarks: s.remarks,
                status: s.status,
                // Flatten the array: take the first refund if it exists
                refund: s.refunds && s.refunds.length > 0 ? s.refunds[0] : null 
            })),
            createdAt: inv.createdAt
        }));

        res.json({ success: true, data });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: "Failed to fetch sales invoices" });
    }
});
/* ======================= SEARCH SALES BY DOCUMENT NO ======================= */
router.get("/search", authenticate, async (req, res) => {
	try {
		const { documentNo } = req.query;

		if (!documentNo) {
			return res.status(400).json({ success: false, error: "documentNo is required" });
		}

		const sales = await prisma.sale.findMany({
			where: {
				documentNo: { contains: documentNo, mode: "insensitive" }
			},
			orderBy: { createdAt: "desc" },
			include: {
				airline: { select: { airlineCode: true, airlineName: true } },
				vendor: {
					select: {
						vendorName: true,
						category: true,
						account: { select: { balance: true } }
					}
				},
				customer: {
					select: {
						customerName: true,
						phone: true,
						account: { select: { balance: true } }
					}
				}
			}
		});

		if (sales.length === 0) {
			return res.json({ success: true, data: [] });
		}

		/* Keep only latest sale per documentNo */
		const latestSaleByDoc = new Map();
		for (const sale of sales) {
			if (!latestSaleByDoc.has(sale.documentNo)) {
				latestSaleByDoc.set(sale.documentNo, sale);
			}
		}

		const data = Array.from(latestSaleByDoc.values()).map(s => ({
			id: s.id,
			documentNo: s.documentNo,
			pnr: s.pnr,
			paxName: s.paxName,
			netPrice: s.netPrice,
			sellPrice: s.sellPrice,
			profit: s.profit,
			status: s.status,
			paymentType: s.paymentType,
			paymentStatus: s.paymentStatus,
			paidAmount: s.paidAmount,
			airlineCode: s.airline?.airlineCode || null,
			airlineName: s.airline?.airlineName || null,
			vendorName: s.vendor?.vendorName || null,
			vendorCategory: s.vendor?.category || null,
			vendorBalance: s.vendor?.account?.balance ?? null,
			customerName: s.customer?.customerName || null,
			customerPhone: s.customer?.phone || null,
			customerBalance: s.customer?.account?.balance ?? null,
			createdAt: s.createdAt
		}));

		res.json({ success: true, data });
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to search sales" });
	}
});

/* ======================= GET INVOICE BY ID ======================= */
router.get("/:invoiceId", authenticate, async (req, res) => {
	try {
		const invoice = await prisma.salesInvoice.findUnique({
			where: { id: req.params.invoiceId },
			include: {
				user: {
					select: { id: true, fullName: true, email: true }
				},
				sales: {
					include: {
						vendor: {
							select: {
								id: true,
								vendorName: true,
								category: true,
								vendorType: true,
								account: { select: { balance: true } },
							},
						},
						airline: {
							select: {
								id: true,
								airlineName: true,
								airlineCode: true,
								iataName: true,
							},
						},
						customer: {
							select: {
								id: true,
								customerName: true,
								customerType: true,
								phone: true,
								contactPerson: true,
								account: { select: { balance: true } },
							},
						},
						// Bank for single BANK_TRANSFER sales
						bank: {
							select: {
								id: true,
								bankName: true,
								accountNumber: true,
								branchName: true,
								account: { select: { balance: true } },
							},
						},
						// Payment legs for PARTIAL sales
						payments: {
							select: {
								id: true,
								method: true,
								amount: true,
								paymentDate: true,
								remarks: true,
								bank: {
									select: {
										id: true,
										bankName: true,
										accountNumber: true,
										branchName: true,
									},
								},
								customer: {
									select: {
										id: true,
										customerName: true,
										customerType: true,
										phone: true,
									},
								},
							},
							orderBy: { paymentDate: "asc" },
						},
					},
				},
			},
		});

		if (!invoice) {
			return res.status(404).json({ success: false, error: "Invoice not found" });
		}

		// Enrich each sale with a normalised paymentSummary so the
		// frontend never has to branch on paymentType itself.
		const enrichedSales = invoice.sales.map((sale) => {
			const pt = String(sale.paymentType).toUpperCase();
			let paymentSummary;

			if (pt === "CASH") {
				paymentSummary = {
					type:   "CASH",
					label:  "Cash",
					amount: sale.paidAmount,
				};
			} else if (pt === "BANK_TRANSFER") {
				paymentSummary = {
					type:      "BANK_TRANSFER",
					label:     "Bank Transfer",
					amount:    sale.paidAmount,
					bankId:    sale.bank?.id            || null,
					bankName:  sale.bank?.bankName       || null,
					accountNo: sale.bank?.accountNumber  || null,
				};
			} else if (pt === "CREDIT") {
				paymentSummary = {
					type:          "CREDIT",
					label:         "Credit",
					amount:        sale.sellPrice,
					paidAmount:    sale.paidAmount,
					dueAmount:     sale.sellPrice - sale.paidAmount,
					customerId:    sale.customer?.id           || null,
					customerName:  sale.customer?.customerName || null,
				};
			} else if (pt === "PARTIAL") {
				const legs = (sale.payments || []).map((leg) => {
					const lm = String(leg.method).toUpperCase();
					return {
						id:           leg.id,
						method:       lm,
						amount:       leg.amount,
						paymentDate:  leg.paymentDate,
						remarks:      leg.remarks      || null,
						// bank fields — only populated for BANK_TRANSFER legs
						bankId:       lm === "BANK_TRANSFER" ? (leg.bank?.id           || null) : null,
						bankName:     lm === "BANK_TRANSFER" ? (leg.bank?.bankName      || null) : null,
						accountNo:    lm === "BANK_TRANSFER" ? (leg.bank?.accountNumber || null) : null,
						// customer fields — only populated for CREDIT legs
						customerId:   lm === "CREDIT" ? (leg.customer?.id           || null) : null,
						customerName: lm === "CREDIT" ? (leg.customer?.customerName || null) : null,
					};
				});

				const comboKey = legs.map((l) => l.method).join("+");

				paymentSummary = {
					type:     "PARTIAL",
					label:    `Split (${legs.length} methods)`,
					combo:    comboKey,
					legs,
					total:    legs.reduce((s, l) => s + l.amount, 0),
				};
			} else {
				paymentSummary = { type: pt, label: pt, amount: sale.paidAmount };
			}

			return { ...sale, paymentSummary };
		});

		res.json({
			success: true,
			data: {
				...invoice,
				sales:          enrichedSales,
				salesCount:     enrichedSales.length,
				createdById:    invoice.user?.id        || null,
				createdByName:  invoice.user?.fullName  || null,
				createdByEmail: invoice.user?.email     || null,
			},
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to fetch invoice" });
	}
});

/* ======================= GET SALE BY ID ======================= */
router.get("/saleId/:saleId", authenticate, async (req, res) => {
	try {
		const sale = await prisma.sale.findUnique({
			where: { id: req.params.saleId },
			include: {
				invoice: true,
				airline: true,
				vendor: {
					include: {
						account: { select: { balance: true } }
					}
				},
				customer: {
					include: {
						account: { select: { balance: true } }
					}
				}
			}
		});

		if (!sale) {
			return res.status(404).json({ success: false, error: "Sale not found" });
		}

		res.json({ success: true, data: sale });
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to fetch sale" });
	}
});

router.get("/invoice-no", authenticate, async (req, res) => {
  try {
    const { saleDate } = req.query;
    const date = saleDate ? new Date(saleDate) : new Date();

    const yy = String(date.getFullYear()).slice(-2);
    const key = `INV-ALR${yy}`;

    const counter = await prisma.invoiceCounter.findUnique({
      where: { key },
      select: { currentNumber: true },
    });

    const next = (counter?.currentNumber || 0) + 1;
    const invoiceNo = `${key}-${String(next).padStart(4, "0")}`;

    return res.json({ success: true, invoiceNo, reserved: false });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
});



/* ===========================
	CREATE SALES (INVOICE HAS userId)
=========================== */
/* ===========================
	CREATE SALES (INVOICE HAS userId)
=========================== */
router.post("/", authenticate, async (req, res) => {
	const { saleDate, sales = [] } = req.body;

	if (!Array.isArray(sales) || sales.length === 0) {
		return res.status(400).json({ success: false, error: "At least one sale is required" });
	}

	try {
		/* ======================================================
		   1️⃣  VALIDATION PHASE
		====================================================== */
		for (const s of sales) {
			const net  = Number(s.netPrice);
			const sell = Number(s.sellPrice);
			const paid = Number(s.paidAmount || 0);
			const vat    = Number(s.vatAmount   || 0);
			const paxVat = Number(s.paxVat      || 0);
			const misc   = Number(s.miscCharges || 0);

			if (isNaN(net) || isNaN(sell))         throw new Error("netPrice and sellPrice must be numbers");
			if (net < 0 || sell < 0)               throw new Error("Prices cannot be negative");
			if (paid < 0 || paid > sell)           throw new Error("Invalid paidAmount");
			if (vat < 0 || paxVat < 0 || misc < 0) throw new Error("Taxes/charges cannot be negative");

			const pt = String(s.paymentType).toUpperCase();

			if (pt === "CREDIT" && !s.customerId)
                throw new Error("customerId required for CREDIT sales");

            if (pt === "BANK_TRANSFER" && !s.bankId)
                throw new Error("bankId required for BANK_TRANSFER sales");

            // if (pt === "BANK_TRANSFER" && paid < sell && !s.customerId)
            //     throw new Error("customerId required for BANK_TRANSFER sales when paidAmount is less than sellPrice");

			if (pt === "PARTIAL") {
				if (!Array.isArray(s.paymentLegs) || s.paymentLegs.length === 0)
					throw new Error("paymentLegs array required for PARTIAL sales");

				for (const leg of s.paymentLegs) {
					const legMethod = String(leg.method || "").toUpperCase();
					if (!["CASH", "BANK_TRANSFER", "CREDIT"].includes(legMethod))
						throw new Error(`Invalid payment leg method: ${leg.method}`);
					if (!Number(leg.amount) || Number(leg.amount) <= 0)
						throw new Error("Each payment leg must have a positive amount");
					if (legMethod === "BANK_TRANSFER" && !leg.bankId)
						throw new Error("bankId required for BANK_TRANSFER leg");
					if (legMethod === "CREDIT" && !leg.customerId)
						throw new Error("customerId required for CREDIT leg");
				}
			}
		}

		/* ── Bulk-load related records ── */
		const vendorIds = [...new Set(sales.map(s => s.vendorId).filter(Boolean))];
		const vendors = vendorIds.length
			? await prisma.vendor.findMany({
					where: { id: { in: vendorIds } },
					include: { account: true },
			  })
			: [];
		const vendorMap = Object.fromEntries(vendors.map(v => [v.id, v]));

		const customerIds = [...new Set([
			...sales
				.filter(s => String(s.paymentType).toUpperCase() === "CREDIT")
				.map(s => s.customerId),
			...sales.flatMap(s =>
				(s.paymentLegs || [])
					.filter(l => String(l.method).toUpperCase() === "CREDIT")
					.map(l => l.customerId)
			),
		].filter(Boolean))];

		const customers = customerIds.length
			? await prisma.customer.findMany({
					where: { id: { in: customerIds } },
					include: { account: true },
			  })
			: [];
		const customerMap = Object.fromEntries(customers.map(c => [c.id, c]));

		const bankIds = [...new Set([
			...sales
				.filter(s => String(s.paymentType).toUpperCase() === "BANK_TRANSFER")
				.map(s => s.bankId),
			...sales.flatMap(s =>
				(s.paymentLegs || [])
					.filter(l => String(l.method).toUpperCase() === "BANK_TRANSFER")
					.map(l => l.bankId)
			),
		].filter(Boolean))];

		const banks = bankIds.length
			? await prisma.bank.findMany({
					where: { id: { in: bankIds } },
					include: { account: true },
			  })
			: [];
		const bankMap = Object.fromEntries(banks.map(b => [b.id, b]));

		/* ── Validate vendor credit balance ── */
		for (const s of sales) {
			const vendor = vendorMap[s.vendorId];
			if (!vendor) throw new Error(`Vendor not found: ${s.vendorId}`);

			if (vendor.category === "CREDIT") {
				const net = Number(s.netPrice || 0);
				const balance = Number(vendor.account?.balance || 0);

				if (net > balance) {
					throw new Error(
						`Insufficient balance for vendor "${vendor.vendorName}". Available: ${balance}, Required: ${net}`
					);
				}
			}
		}

		/* ======================================================
		   2️⃣  TRANSACTION PHASE
		====================================================== */
		const businessDate = saleDate ? new Date(saleDate) : new Date();

		const result = await prisma.$transaction(async (tx) => {
			/* ── Invoice ── */
			const invoiceNo = await generateNextSalesInvoiceNo(tx, businessDate);

			const invoice = await tx.salesInvoice.create({
				data: {
					invoiceNo,
					saleDate: businessDate,
					userId: req.user.id,
				},
			});

			/* ──────────────────────────────────────────────────────
			   HELPER: record money received into bank account
			   ────────────────────────────────────────────────────── */
			const creditBank = async (bankId, amount, saleId, label) => {
				const bank = bankMap[bankId];
				if (!bank) throw new Error(`Bank not found: ${bankId}`);

				await tx.ledgerEntry.create({
					data: {
						accountId: bank.account.id,
						entryType: "PAYMENT",
						debit: 0,
						credit: amount,
						transactionDate: businessDate,
						saleId,
						invoiceId: invoice.id,
						remarks: `${label} - Invoice ${invoiceNo}`,
					},
				});

				await tx.account.update({
					where: { id: bank.account.id },
					data: { balance: { increment: amount } },
				});
			};

			/* ──────────────────────────────────────────────────────
			   HELPER: record a credit sale against a customer
			   ────────────────────────────────────────────────────── */
			const creditCustomer = async (customerId, saleAmount, paidNow, saleId, label) => {
				const cust = customerMap[customerId];
				if (!cust) throw new Error(`Customer not found: ${customerId}`);

				await tx.ledgerEntry.create({
					data: {
						accountId: cust.account.id,
						entryType: "SALE",
						debit: saleAmount,
						credit: 0,
						transactionDate: businessDate,
						saleId,
						invoiceId: invoice.id,
						remarks: `${label} - Invoice ${invoiceNo}`,
					},
				});

				if (paidNow > 0) {
					await tx.ledgerEntry.create({
						data: {
							accountId: cust.account.id,
							entryType: "PAYMENT",
							debit: 0,
							credit: paidNow,
							transactionDate: businessDate,
							saleId,
							invoiceId: invoice.id,
							remarks: `Payment received - Invoice ${invoiceNo}`,
						},
					});
				}

				const netReceivable = saleAmount - paidNow;

				await tx.account.update({
					where: { id: cust.account.id },
					data: { balance: { increment: netReceivable } },
				});
			};

			let totalNet = 0,
				totalSell = 0,
				totalProfit = 0;

			/* ── Process each sale ── */
			for (const s of sales) {
				const vendor = vendorMap[s.vendorId];
				const net = Number(s.netPrice);
				const sell = Number(s.sellPrice);
				const paid = Number(s.paidAmount || 0);
				const profit = sell - net;
				const pt = String(s.paymentType).toUpperCase();

				/* ── Create sale record ── */
				const sale = await tx.sale.create({
					data: {
						invoiceId: invoice.id,
						airlineId: s.airlineId,
						vendorId: s.vendorId,
						customerId: s.customerId || null,
						bankId: pt === "BANK_TRANSFER" ? (s.bankId || null) : null,
						documentNo: s.documentNo || null,
						pnr: s.pnr || null,
						routeType: s.routeType || null,
						tripType: s.tripType || "Oneway",
						departureDate: s.departureDate ? new Date(s.departureDate) : null,
						returnDate: s.returnDate ? new Date(s.returnDate) : null,
						paxName: s.paxName || null,
						destinations: s.destinations || null,
						netPrice: net,
						sellPrice: sell,
						profit,
						vatAmount: Number(s.vatAmount || 0),
						paxVat: Number(s.paxVat || 0),
						miscCharges: Number(s.miscCharges || 0),
						paidAmount: paid,
						paymentType: pt,
						paymentStatus: paid >= sell ? "PAID" : paid > 0 ? "PARTIAL" : "DUE",
						status: "COMPLETED",
					},
				});

				/* ── Vendor ledger entry (cost side) ── */
				const isDebitVendor = vendor.category === "DEBIT";

				await tx.ledgerEntry.create({
					data: {
						accountId: vendor.account.id,
						entryType: "SALE",
						debit: 0,
						credit: net,
						transactionDate: businessDate,
						saleId: sale.id,
						invoiceId: invoice.id,
						remarks: `Sale cost - Invoice ${invoiceNo}`,
					},
				});

				await tx.account.update({
					where: { id: vendor.account.id },
					data: { balance: { increment: isDebitVendor ? net : -net } },
				});

				/* ── Payment-side ledger entries ── */
				if (pt === "CASH") {
                    // No ledger entry for cash payments
                } else if (pt === "BANK_TRANSFER") {
                    await creditBank(s.bankId, paid, sale.id, "Bank transfer payment received");

                    const remainingBT = sell - paid;
                    if (remainingBT > 0 && s.customerId) {
                        await creditCustomer(s.customerId, remainingBT, 0, sale.id, "Balance due after bank transfer");
                    }
                } else if (pt === "CREDIT") {
                    await creditCustomer(s.customerId, sell, paid, sale.id, "Sale on credit");
                } else if (pt === "PARTIAL") {
					for (const leg of s.paymentLegs) {
						const legMethod = String(leg.method).toUpperCase();
						const legAmount = Number(leg.amount);

						await tx.salePayment.create({
							data: {
								saleId: sale.id,
								method: legMethod,
								amount: legAmount,
								bankId: legMethod === "BANK_TRANSFER" ? (leg.bankId || null) : null,
								customerId: legMethod === "CREDIT" ? (leg.customerId || null) : null,
								remarks: leg.remarks || null,
								paymentDate: businessDate,
							},
						});

						if (legMethod === "CASH") {
							// No ledger entry for cash payment legs
						} else if (legMethod === "BANK_TRANSFER") {
							await creditBank(
								leg.bankId,
								legAmount,
								sale.id,
								"Partial bank transfer received"
							);
						} else if (legMethod === "CREDIT") {
							await creditCustomer(
								leg.customerId,
								legAmount,
								0,
								sale.id,
								"Partial credit sale"
							);
						}
					}
				}

				totalNet += net;
				totalSell += sell;
				totalProfit += profit;
			}

			/* ── Update invoice totals ── */
			await tx.salesInvoice.update({
				where: { id: invoice.id },
				data: { totalNet, totalSell, totalProfit },
			});

			return invoice;
		}, { timeout: 50000 });

		return res.status(201).json({
			success: true,
			message: "Sales processed successfully",
			data: result,
		});
	} catch (err) {
		console.error(err);
		return res.status(400).json({ success: false, error: err.message });
	}
});


router.put("/:invoiceId", authenticate, async (req, res) => {
	const { invoiceId } = req.params;
	const { invoiceNo, saleDate, sales = [] } = req.body;

	if (!Array.isArray(sales)) {
		return res.status(400).json({ success: false, error: "sales must be an array" });
	}

	try {
		/* ======================================================
		   1️⃣  LOAD EXISTING INVOICE
		====================================================== */
		const existingInvoice = await prisma.salesInvoice.findUnique({
			where: { id: invoiceId },
			include: {
				sales: {
					include: {
						vendor: { include: { account: true } },
						customer: { include: { account: true } },
						bank: { include: { account: true } },
						payments: {                              // SalePayment legs
							include: {
								bank: { include: { account: true } },
								customer: { include: { account: true } },
							},
						},
					},
				},
			},
		});

		if (!existingInvoice) {
			return res.status(404).json({ success: false, error: "Invoice not found" });
		}

		const saleMap = new Map(existingInvoice.sales.map(s => [s.id, s]));

		for (const s of sales) {
			if (!s.id) throw new Error("Each sale must include 'id'");
			if (!saleMap.has(s.id)) throw new Error(`Sale not found in invoice: ${s.id}`);
		}

		/* ======================================================
		   2️⃣  DELETED SALES (omitted from payload)
		====================================================== */
		const payloadSaleIds = new Set(sales.map(s => s.id));
		const deletedSales = existingInvoice.sales.filter(s => !payloadSaleIds.has(s.id));

		/* ======================================================
		   3️⃣  PRE-LOAD ALL VENDORS / CUSTOMERS / BANKS
		====================================================== */
		const vendorIdSet = new Set();
		const customerIdSet = new Set();
		const bankIdSet = new Set();

		// Collect from existing sales (for reversal)
		existingInvoice.sales.forEach(s => {
			if (s.vendorId) vendorIdSet.add(s.vendorId);
			if (s.customerId) customerIdSet.add(s.customerId);
			if (s.bankId) bankIdSet.add(s.bankId);
			s.payments?.forEach(leg => {
				if (leg.customerId) customerIdSet.add(leg.customerId);
				if (leg.bankId) bankIdSet.add(leg.bankId);
			});
		});

		// Collect from incoming payload (for applying new entries)
		sales.forEach(s => {
			if (s.vendorId) vendorIdSet.add(s.vendorId);
			if (s.customerId) customerIdSet.add(s.customerId);
			if (s.bankId) bankIdSet.add(s.bankId);
			(s.paymentLegs || []).forEach(leg => {
				if (leg.customerId) customerIdSet.add(leg.customerId);
				if (leg.bankId) bankIdSet.add(leg.bankId);
			});
		});

		const [vendors, customers, banks] = await Promise.all([
			vendorIdSet.size
				? prisma.vendor.findMany({ where: { id: { in: [...vendorIdSet] } }, include: { account: true } })
				: [],
			customerIdSet.size
				? prisma.customer.findMany({ where: { id: { in: [...customerIdSet] } }, include: { account: true } })
				: [],
			bankIdSet.size
				? prisma.bank.findMany({ where: { id: { in: [...bankIdSet] } }, include: { account: true } })
				: [],
		]);

		const vendorMap = new Map(vendors.map(v => [v.id, v]));
		const customerMap = new Map(customers.map(c => [c.id, c]));
		const bankMap = new Map(banks.map(b => [b.id, b]));

		const businessDate = saleDate ? new Date(saleDate) : new Date();

		/* ======================================================
		   4️⃣  TRANSACTION
		====================================================== */
		const result = await prisma.$transaction(async (tx) => {

			/* ── Update invoice header ── */
			await tx.salesInvoice.update({
				where: { id: invoiceId },
				data: { invoiceNo, saleDate: businessDate },
			});

			/* ── In-memory balance tracking ── */
			const balances = new Map();
			const touchedAccounts = new Set();

			const seedBalance = (acc) => {
				if (acc && !balances.has(acc.id)) balances.set(acc.id, Number(acc.balance || 0));
			};

			// Seed from existing data
			existingInvoice.sales.forEach(s => {
				seedBalance(s.vendor?.account);
				seedBalance(s.customer?.account);
				seedBalance(s.bank?.account);
				s.payments?.forEach(leg => {
					seedBalance(leg.bank?.account);
					seedBalance(leg.customer?.account);
				});
			});

			// Seed from incoming (in case new entities are referenced)
			vendors.forEach(v => seedBalance(v.account));
			customers.forEach(c => seedBalance(c.account));
			banks.forEach(b => seedBalance(b.account));

			const getBal = (id) => balances.get(id) || 0;
			const setBal = (id, v) => { balances.set(id, Number(v)); touchedAccounts.add(id); };
			const adjBal = (id, d) => setBal(id, getBal(id) + d);

			/* ══════════════════════════════════════════════════════
			   HELPERS — mirror the POST helpers exactly
			══════════════════════════════════════════════════════ */

			/** Apply a bank-received-payment ledger entry (money in) */
			const applyBankPayment = async (bankId, amount, saleId) => {
				const bank = bankMap.get(bankId);
				if (!bank) throw new Error(`Bank not found: ${bankId}`);
				await tx.ledgerEntry.create({
					data: {
						accountId: bank.account.id, entryType: "PAYMENT",
						debit: 0, credit: amount,
						transactionDate: businessDate,
						saleId, invoiceId,
						remarks: `Bank transfer received - Invoice ${invoiceNo}`,
					},
				});
				adjBal(bank.account.id, amount);
			};

			/** Reverse a previous bank-received-payment (money out) */
			const reverseBankPayment = async (bankId, amount, saleId) => {
				const bank = bankMap.get(bankId);
				if (!bank) return;
				await tx.ledgerEntry.deleteMany({
					where: { saleId, accountId: bank.account.id, entryType: "PAYMENT" },
				});
				adjBal(bank.account.id, -amount);
			};

			/** Apply credit-sale + optional immediate payment entries */
			const applyCreditSale = async (customerId, saleAmount, paidNow, saleId) => {
				const cust = customerMap.get(customerId);
				if (!cust) throw new Error(`Customer not found: ${customerId}`);
				await tx.ledgerEntry.create({
					data: {
						accountId: cust.account.id, entryType: "SALE",
						debit: saleAmount, credit: 0,
						transactionDate: businessDate,
						saleId, invoiceId,
						remarks: `Sale on credit - Invoice ${invoiceNo}`,
					},
				});
				await tx.ledgerEntry.create({
					data: {
						accountId: cust.account.id, entryType: "PAYMENT",
						debit: 0, credit: paidNow,
						transactionDate: businessDate,
						saleId, invoiceId,
						remarks: `Payment received - Invoice ${invoiceNo}`,
					},
				});
				adjBal(cust.account.id, saleAmount - paidNow);
			};

			/** Reverse all credit entries for a sale on a customer account */
			const reverseCreditSale = async (customerId, oldSell, oldPaid, saleId) => {
				const cust = customerMap.get(customerId);
				if (!cust) return;
				await tx.ledgerEntry.deleteMany({
					where: { saleId, accountId: cust.account.id, entryType: { in: ["SALE", "PAYMENT"] } },
				});
				adjBal(cust.account.id, -(oldSell - oldPaid));
			};

			/* ══════════════════════════════════════════════════════
			   4.1  DELETE OMITTED SALES (full reversal)
			══════════════════════════════════════════════════════ */
			for (const sale of deletedSales) {
				const net = Number(sale.netPrice);
				const sell = Number(sale.sellPrice);
				const paid = Number(sale.paidAmount || 0);
				const pt = String(sale.paymentType).toUpperCase();

				// Vendor reversal
				if (sale.vendor?.account) {
					const isDebit = sale.vendor.category === "DEBIT";
					await tx.ledgerEntry.deleteMany({
						where: { saleId: sale.id, accountId: sale.vendor.account.id, entryType: "SALE" },
					});
					adjBal(sale.vendor.account.id, isDebit ? -net : net);
				}

				// Payment-side reversal
				// Payment-side reversal
				if (pt === "BANK_TRANSFER" && sale.bank?.account) {
					await reverseBankPayment(sale.bankId, paid, sale.id);
					if (sell - paid > 0 && sale.customer?.account) {
						await reverseCreditSale(sale.customerId, sell - paid, 0, sale.id);
					}
				}

				if (pt === "CREDIT" && sale.customer?.account) {
					await reverseCreditSale(sale.customerId, sell, paid, sale.id);
				}

				if (pt === "PARTIAL") {
					for (const leg of (sale.payments || [])) {
						const lm = String(leg.method).toUpperCase();
						if (lm === "BANK_TRANSFER" && leg.bank?.account) {
							await reverseBankPayment(leg.bankId, leg.amount, sale.id);
						}
						if (lm === "CREDIT" && leg.customer?.account) {
							await reverseCreditSale(leg.customerId, leg.amount, 0, sale.id);
						}
					}
					await tx.salePayment.deleteMany({ where: { saleId: sale.id } });
				}

				await tx.sale.delete({ where: { id: sale.id } });
			}

			/* ══════════════════════════════════════════════════════
			   4.2  UPDATE EACH SALE IN PAYLOAD
			══════════════════════════════════════════════════════ */
			let totalNet = 0, totalSell = 0, totalProfit = 0;

			for (const payload of sales) {
				const current = saleMap.get(payload.id);

				const oldNet = Number(current.netPrice);
				const newNet = Number(payload.netPrice);
				const oldSell = Number(current.sellPrice);
				const newSell = Number(payload.sellPrice);
				const oldPaid = Number(current.paidAmount || 0);
				const newPaid = Number(payload.paidAmount || 0);

				if (isNaN(newNet) || isNaN(newSell)) throw new Error("Invalid prices");
				if (newNet < 0 || newSell < 0) throw new Error("Prices cannot be negative");
				if (newPaid < 0 || newPaid > newSell) throw new Error("Invalid paidAmount");

				const oldPt = String(current.paymentType).toUpperCase();
				const newPt = String(payload.paymentType || current.paymentType).toUpperCase();

				const vendorChanged = current.vendorId !== payload.vendorId;
				const customerChanged = (current.customerId || null) !== (payload.customerId || null);
				const bankChanged = (current.bankId || null) !== (payload.bankId || null);
				const netChanged = oldNet !== newNet;
				const sellChanged = oldSell !== newSell;
				const paidChanged = oldPaid !== newPaid;
				const paymentTypeChanged = oldPt !== newPt;

				/* ── Validation ── */
				if (newPt === "CREDIT" && !payload.customerId)
					throw new Error("customerId required for CREDIT sales");
				if (newPt === "BANK_TRANSFER" && !payload.bankId)
					throw new Error("bankId required for BANK_TRANSFER sales");
				if (newPt === "PARTIAL") {
					if (!Array.isArray(payload.paymentLegs) || payload.paymentLegs.length === 0)
						throw new Error("paymentLegs required for PARTIAL sales");
					for (const leg of payload.paymentLegs) {
						const lm = String(leg.method || "").toUpperCase();
						if (!["CASH", "BANK_TRANSFER", "CREDIT"].includes(lm))
							throw new Error(`Invalid payment leg method: ${leg.method}`);
						if (!Number(leg.amount) || Number(leg.amount) <= 0)
							throw new Error("Each payment leg must have a positive amount");
						if (lm === "BANK_TRANSFER" && !leg.bankId)
							throw new Error("bankId required for BANK_TRANSFER leg");
						if (lm === "CREDIT" && !leg.customerId)
							throw new Error("customerId required for CREDIT leg");
					}
				}

				/* ── VENDOR: handle change or net price change ── */
				if (vendorChanged) {
					// Reverse old vendor
					const oldVendor = vendorMap.get(current.vendorId);
					if (oldVendor?.account) {
						const isDebit = oldVendor.category === "DEBIT";
						await tx.ledgerEntry.deleteMany({
							where: { saleId: current.id, accountId: oldVendor.account.id, entryType: "SALE" },
						});
						adjBal(oldVendor.account.id, isDebit ? -oldNet : oldNet);
					}
					// Apply new vendor
					const newVendor = vendorMap.get(payload.vendorId);
					if (!newVendor?.account) throw new Error("Vendor not found");
					if (newVendor.category === "CREDIT" && newNet > getBal(newVendor.account.id))
						throw new Error(`Insufficient balance for vendor "${newVendor.vendorName}"`);
					const isDebit = newVendor.category === "DEBIT";
					await tx.ledgerEntry.create({
						data: {
							accountId: newVendor.account.id, entryType: "SALE",
							debit: 0,
							credit: newNet,
							transactionDate: businessDate, saleId: current.id, invoiceId,
							remarks: `Sale - Invoice ${invoiceNo}`,
						},
					});
					adjBal(newVendor.account.id, isDebit ? newNet : -newNet);

				} else if (netChanged) {
					// Same vendor, net changed — update ledger entry amount
					const vendor = vendorMap.get(current.vendorId);
					if (!vendor?.account) throw new Error("Vendor not found");
					if (vendor.category === "CREDIT" && (newNet - oldNet) > getBal(vendor.account.id))
						throw new Error(`Insufficient balance for vendor "${vendor.vendorName}"`);
					const isDebit = vendor.category === "DEBIT";
					await tx.ledgerEntry.updateMany({
						where: { saleId: current.id, accountId: vendor.account.id, entryType: "SALE" },
						data: {
							debit: 0,
							credit: newNet,
							transactionDate: businessDate
						},
					});
					adjBal(vendor.account.id, isDebit ? (newNet - oldNet) : -(newNet - oldNet));
				}

				/* ── PAYMENT-SIDE: fully reverse old, fully apply new ──────────
				   Trigger full reversal+reapply whenever:
				   - payment type changed
				   - bank changed (BANK_TRANSFER)
				   - customer changed (CREDIT)
				   - sell price changed (affects bank/credit amount)
				   - paid amount changed (affects credit balance)
				   - payment legs changed (PARTIAL)
				   ─────────────────────────────────────────────────────────────── */
				const paymentSideChanged =
					paymentTypeChanged || sellChanged || paidChanged || customerChanged || bankChanged ||
					(newPt === "PARTIAL"); // always re-sync partial legs

				if (paymentSideChanged) {
					/* ── REVERSE OLD payment side ── */
					/* ── REVERSE OLD payment side ── */
					if (oldPt === "BANK_TRANSFER" && current.bankId) {
						await reverseBankPayment(current.bankId, oldPaid, current.id);
						const oldRemainingBT = oldSell - oldPaid;
						if (oldRemainingBT > 0 && current.customerId) {
							await reverseCreditSale(current.customerId, oldRemainingBT, 0, current.id);
						}
					}

					if (oldPt === "CREDIT" && current.customerId) {
						await reverseCreditSale(current.customerId, oldSell, oldPaid, current.id);
					}

					if (oldPt === "PARTIAL") {
						for (const leg of (current.payments || [])) {
							const lm = String(leg.method).toUpperCase();
							if (lm === "BANK_TRANSFER" && leg.bankId) {
								await reverseBankPayment(leg.bankId, leg.amount, current.id);
							}
							if (lm === "CREDIT" && leg.customerId) {
								await reverseCreditSale(leg.customerId, leg.amount, 0, current.id);
							}
						}
						// Delete all old SalePayment legs
						await tx.salePayment.deleteMany({ where: { saleId: current.id } });
					}

					/* ── APPLY NEW payment side ── */
					if (newPt === "CASH") {
						// Cash: no payment-side account entry
					}

					else if (newPt === "BANK_TRANSFER") {
						await applyBankPayment(payload.bankId, newPaid, current.id);
						const remainingBT = newSell - newPaid;
						if (remainingBT > 0 && payload.customerId) {
							await applyCreditSale(payload.customerId, remainingBT, 0, current.id);
						}
					}

					else if (newPt === "CREDIT") {
						await applyCreditSale(payload.customerId, newSell, newPaid, current.id);
					}

					else if (newPt === "PARTIAL") {
						for (const leg of payload.paymentLegs) {
							const lm = String(leg.method).toUpperCase();
							const legAmount = Number(leg.amount);

							// Persist SalePayment leg record
							await tx.salePayment.create({
								data: {
									saleId: current.id,
									method: lm,
									amount: legAmount,
									bankId: lm === "BANK_TRANSFER" ? (leg.bankId || null) : null,
									customerId: lm === "CREDIT" ? (leg.customerId || null) : null,
									remarks: leg.remarks || null,
									paymentDate: businessDate,
								},
							});

							if (lm === "BANK_TRANSFER") {
								await applyBankPayment(leg.bankId, legAmount, current.id);
							}

							if (lm === "CREDIT") {
								await applyCreditSale(leg.customerId, legAmount, 0, current.id);
							}
							// CASH leg: no account entry
						}
					}
				}

				/* ── UPDATE SALE RECORD ── */
				await tx.sale.update({
					where: { id: current.id },
					data: {
						airlineId: payload.airlineId,
						vendorId: payload.vendorId,
						customerId: (newPt === "CREDIT" || newPt === "BANK_TRANSFER") ? (payload.customerId || null) : null,
						bankId: newPt === "BANK_TRANSFER" ? (payload.bankId || null) : null,
						documentNo: payload.documentNo || null,
						pnr: payload.pnr ?? current.pnr,
						routeType: payload.routeType ?? current.routeType,
						tripType: payload.tripType ?? current.tripType,
						departureDate: payload.departureDate ? new Date(payload.departureDate) : current.departureDate,
						returnDate: payload.returnDate ? new Date(payload.returnDate) : current.returnDate,
						paxName: payload.paxName ?? current.paxName,
						destinations: payload.destinations ?? current.destinations,
						netPrice: newNet,
						sellPrice: newSell,
						profit: newSell - newNet,
						vatAmount: Number(payload.vatAmount || 0),
						paxVat: Number(payload.paxVat || 0),
						miscCharges: Number(payload.miscCharges || 0),
						paidAmount: newPaid,
						paymentType: newPt,
						paymentStatus: newPaid >= newSell ? "PAID" : newPaid > 0 ? "PARTIAL" : "DUE",
						remarks: payload.remarks || null,
					},
				});

				totalNet += newNet;
				totalSell += newSell;
				totalProfit += newSell - newNet;
			}

			/* ══════════════════════════════════════════════════════
			   4.3  PERSIST ACCOUNT BALANCES
			══════════════════════════════════════════════════════ */
			for (const accId of touchedAccounts) {
				await tx.account.update({
					where: { id: accId },
					data: { balance: getBal(accId) },
				});
			}

			/* ══════════════════════════════════════════════════════
			   4.4  UPDATE INVOICE TOTALS
			══════════════════════════════════════════════════════ */
			await tx.salesInvoice.update({
				where: { id: invoiceId },
				data: { totalNet, totalSell, totalProfit },
			});

			return { invoiceId, deletedSalesCount: deletedSales.length };

		}, { timeout: 30000, maxWait: 10000 });

		return res.json({
			success: true,
			message: "Invoice updated successfully",
			data: result,
		});

	} catch (err) {
		console.error(err);
		return res.status(400).json({ success: false, error: err.message });
	}
});

/* ======================= DELETE INVOICE ======================= */
router.delete("/:invoiceId", authenticate, async (req, res) => {
	const { invoiceId } = req.params;
	
	try {
		await prisma.$transaction(async (tx) => {
			/* 1️⃣ Load invoice with sales */
			const invoice = await tx.salesInvoice.findUnique({
				where: { id: invoiceId },
				include: {
					sales: {
						include: {
							vendor: { include: { account: true } },
							customer: { include: { account: true } }
						}
					}
				}
			});

			if (!invoice) throw new Error("Invoice not found");

			/* 2️⃣ Reverse each sale */
			for (const sale of invoice.sales) {
				const net = Number(sale.netPrice);
				const sell = Number(sale.sellPrice);
				const paid = Number(sale.paidAmount || 0);
				const isCredit = String(sale.paymentType).toUpperCase() === "CREDIT";

				/* ──────────────────────────────────────────────────
				   VENDOR REVERSAL
				────────────────────────────────────────────────── */
				if (sale.vendor?.account) {
					const vendor = sale.vendor;
					const accId = vendor.account.id;
					const isDebit = vendor.category === "DEBIT";

					/* Reverse the sale effect */
					const delta = isDebit ? -net : net; // Opposite of original

					/* Delete original SALE ledger entries */
					await tx.ledgerEntry.deleteMany({
						where: {
							saleId: sale.id,
							accountId: accId,
							entryType: "SALE"
						}
					});

					/* Update vendor balance */
					await tx.account.update({
						where: { id: accId },
						data: { balance: { increment: delta } }
					});
				}

				/* ──────────────────────────────────────────────────
				   CUSTOMER REVERSAL (if CREDIT sale)
				────────────────────────────────────────────────── */
				if (isCredit && sale.customer?.account) {
					const accId = sale.customer.account.id;

					/* Delete SALE ledger entry */
					await tx.ledgerEntry.deleteMany({
						where: {
							saleId: sale.id,
							accountId: accId,
							entryType: "SALE"
						}
					});

					/* Delete PAYMENT ledger entry (if exists) */
					await tx.ledgerEntry.deleteMany({
						where: {
							saleId: sale.id,
							accountId: accId,
							entryType: "PAYMENT"
						}
					});

					/* Update customer balance */
					const balanceDelta = -sell + paid; // Remove sale, restore payment
					await tx.account.update({
						where: { id: accId },
						data: { balance: { increment: balanceDelta } }
					});
				}
			}

			/* 3️⃣ Delete all ledger entries for this invoice */
			await tx.ledgerEntry.deleteMany({
				where: { invoiceId }
			});

			/* 4️⃣ Delete sales */
			await tx.sale.deleteMany({
				where: { invoiceId }
			});

			/* 5️⃣ Delete invoice */
			await tx.salesInvoice.delete({
				where: { id: invoiceId }
			});
		});

		res.json({ 
			success: true,
			message: "Invoice deleted successfully"
		});
	} catch (err) {
		console.error(err);
		res.status(400).json({
			success: false,
			error: err.message || "Failed to delete invoice"
		});
	}
});

router.delete("/sale/:saleId", authenticate, async (req, res) => {
	const { saleId } = req.params;

	try {
		await prisma.$transaction(async (tx) => {
			/* ── 1. Fetch sale with everything needed for reversal ── */
			const sale = await tx.sale.findUnique({
				where: { id: saleId },
				include: {
					invoice: { include: { sales: true } },
					vendor: { include: { account: true } },
					customer: { include: { account: true } },
					bank: { include: { account: true } },
					payments: {
						include: {
							bank: { include: { account: true } },
							customer: { include: { account: true } },
						},
					},
				},
			});

			if (!sale) throw new Error("Sale record not found");

			const net = Number(sale.netPrice || 0);
			const sell = Number(sale.sellPrice || 0);
			const paid = Number(sale.paidAmount || 0);
			const pt = String(sale.paymentType || "").toUpperCase();
			const invoiceId = sale.invoiceId;

			/* ══════════════════════════════════════════════════════
			   STEP 1 — REVERSE VENDOR SIDE
			   Undo vendor SALE ledger + restore account balance
			══════════════════════════════════════════════════════ */
			if (sale.vendor?.account) {
				const vendorAccId = sale.vendor.account.id;
				const isDebitVendor = sale.vendor.category === "DEBIT";

				await tx.ledgerEntry.deleteMany({
					where: {
						saleId: sale.id,
						accountId: vendorAccId,
						entryType: "SALE",
					},
				});

				await tx.account.update({
					where: { id: vendorAccId },
					data: {
						balance: {
							increment: isDebitVendor ? -net : net,
						},
					},
				});
			}

			/* ══════════════════════════════════════════════════════
			   STEP 2 — REVERSE PAYMENT SIDE
			══════════════════════════════════════════════════════ */

			if (pt === "CASH") {
				/* No ledger entry for cash in create API, so nothing to reverse */
			}

			else if (pt === "BANK_TRANSFER") {
				/* Bank received full sell amount in create API */
				if (!sale.bank?.account) {
					throw new Error("Related bank account not found for bank transfer sale");
				}

				await tx.ledgerEntry.deleteMany({
					where: {
						saleId: sale.id,
						accountId: sale.bank.account.id,
						entryType: "PAYMENT",
					},
				});

				await tx.account.update({
					where: { id: sale.bank.account.id },
					data: {
						balance: { decrement: sell },
					},
				});
			}

			else if (pt === "CREDIT") {
				/* creditCustomer(s.customerId, sell, paid, sale.id, ...) was used in create API
				   => customer balance incremented by (sell - paid)
				   => SALE ledger created for sell
				   => PAYMENT ledger created only if paid > 0
				*/
				if (!sale.customer?.account) {
					throw new Error("Related customer account not found for credit sale");
				}

				const customerAccId = sale.customer.account.id;

				await tx.ledgerEntry.deleteMany({
					where: {
						saleId: sale.id,
						accountId: customerAccId,
						entryType: { in: ["SALE", "PAYMENT"] },
					},
				});

				await tx.account.update({
					where: { id: customerAccId },
					data: {
						balance: { decrement: sell - paid },
					},
				});
			}

			else if (pt === "PARTIAL") {
				/* Reverse each salePayment leg one by one */
				for (const leg of sale.payments) {
					const legMethod = String(leg.method || "").toUpperCase();
					const legAmount = Number(leg.amount || 0);

					if (legMethod === "CASH") {
						/* No ledger entry for cash leg in create API */
						continue;
					}

					if (legMethod === "BANK_TRANSFER") {
						if (!leg.bank?.account) {
							throw new Error(`Related bank account not found for payment leg ${leg.id}`);
						}

						await tx.ledgerEntry.deleteMany({
							where: {
								saleId: sale.id,
								accountId: leg.bank.account.id,
								entryType: "PAYMENT",
							},
						});

						await tx.account.update({
							where: { id: leg.bank.account.id },
							data: {
								balance: { decrement: legAmount },
							},
						});
					}

					else if (legMethod === "CREDIT") {
						if (!leg.customer?.account) {
							throw new Error(`Related customer account not found for payment leg ${leg.id}`);
						}

						await tx.ledgerEntry.deleteMany({
							where: {
								saleId: sale.id,
								accountId: leg.customer.account.id,
								entryType: { in: ["SALE", "PAYMENT"] },
							},
						});

						/* For partial credit leg, create API did:
						   creditCustomer(customerId, legAmount, 0, ...)
						   => balance incremented by legAmount
						*/
						await tx.account.update({
							where: { id: leg.customer.account.id },
							data: {
								balance: { decrement: legAmount },
							},
						});
					}
				}

				/* Delete payment legs after reversal */
				await tx.salePayment.deleteMany({
					where: { saleId: sale.id },
				});
			}

			/* ══════════════════════════════════════════════════════
			   STEP 3 — SAFETY CLEANUP
			   Delete any remaining ledger entries attached to this sale
			══════════════════════════════════════════════════════ */
			await tx.ledgerEntry.deleteMany({
				where: { saleId: sale.id },
			});

			/* ══════════════════════════════════════════════════════
			   STEP 4 — DELETE SALE
			══════════════════════════════════════════════════════ */
			await tx.sale.delete({
				where: { id: sale.id },
			});

			/* ══════════════════════════════════════════════════════
			   STEP 5 — UPDATE OR DELETE PARENT INVOICE
			══════════════════════════════════════════════════════ */
			const remainingSales = sale.invoice.sales.filter((s) => s.id !== sale.id);

			if (remainingSales.length === 0) {
				await tx.salesInvoice.delete({
					where: { id: invoiceId },
				});
			} else {
				const newTotalNet = remainingSales.reduce(
					(sum, s) => sum + Number(s.netPrice || 0),
					0
				);
				const newTotalSell = remainingSales.reduce(
					(sum, s) => sum + Number(s.sellPrice || 0),
					0
				);
				const newTotalProfit = remainingSales.reduce(
					(sum, s) => sum + Number(s.profit || 0),
					0
				);

				await tx.salesInvoice.update({
					where: { id: invoiceId },
					data: {
						totalNet: newTotalNet,
						totalSell: newTotalSell,
						totalProfit: newTotalProfit,
					},
				});
			}
		}, { timeout: 30000 });

		return res.json({
			success: true,
			message: "Sale deleted and related balances reversed successfully",
		});
	} catch (err) {
		console.error(err);
		return res.status(400).json({
			success: false,
			error: err.message,
		});
	}
});
export default router;
