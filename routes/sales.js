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
				user: { select: { id: true, fullName: true, email: true } },
				sales: {
					include: {
						vendor: {
							select: {
								id: true,
								vendorName: true,
								category: true,
								vendorType: true,
								account: { select: { balance: true } }
							}
						},
						airline: {
							select: {
								id: true,
								airlineName: true,
								airlineCode: true,
								iataName: true
							}
						},
						customer: {
							select: {
								id: true,
								customerName: true,
								customerType: true,
								phone: true,
								contactPerson: true,
								account: { select: { balance: true } }
							}
						}
					}
				}
			}
		});

		if (!invoice) {
			return res.status(404).json({ success: false, error: "Invoice not found" });
		}

		res.json({
			success: true,
			data: {
				...invoice,
				salesCount: invoice.sales.length,
				createdById: invoice.user?.id || null,
				createdByName: invoice.user?.fullName || null,
				createdByEmail: invoice.user?.email || null
			}
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
router.post("/", authenticate, async (req, res) => {
	const { saleDate, sales = [] } = req.body;

	if (!Array.isArray(sales) || sales.length === 0) {
		return res.status(400).json({ success: false, error: "At least one sale is required" });
	}

	try {
		/* ====================================================== 
		   1️⃣ VALIDATION PHASE 
		====================================================== */
		
		for (const s of sales) {
			const net = Number(s.netPrice);
			const sell = Number(s.sellPrice);
			const paid = Number(s.paidAmount || 0);
			const vat = Number(s.vatAmount || 0);
			const paxVat = Number(s.paxVat || 0);
			const misc = Number(s.miscCharges || 0);

			if (isNaN(net) || isNaN(sell)) throw new Error("netPrice and sellPrice must be numbers");
			if (net < 0 || sell < 0) throw new Error("Prices cannot be negative");
			if (paid < 0 || paid > sell) throw new Error("Invalid paidAmount");
			if (vat < 0 || paxVat < 0 || misc < 0) throw new Error("Taxes/charges cannot be negative");
			if (String(s.paymentType).toUpperCase() === "CREDIT" && !s.customerId) {
				throw new Error("customerId required for CREDIT sales");
			}
		}

		/* Load vendors & customers */
		const vendorIds = [...new Set(sales.map(s => s.vendorId).filter(Boolean))];
		const customerIds = [...new Set(sales.filter(s => String(s.paymentType).toUpperCase() === "CREDIT").map(s => s.customerId))];

		const vendors = vendorIds.length ? await prisma.vendor.findMany({
			where: { id: { in: vendorIds } },
			include: { account: true }
		}) : [];

		const customers = customerIds.length ? await prisma.customer.findMany({
			where: { id: { in: customerIds } },
			include: { account: true }
		}) : [];

		const vendorMap = Object.fromEntries(vendors.map(v => [v.id, v]));
		const customerMap = Object.fromEntries(customers.map(c => [c.id, c]));

		/* Validate CREDIT vendor balance */
		for (const s of sales) {
			const vendor = vendorMap[s.vendorId];
			if (!vendor) throw new Error(`Vendor not found: ${s.vendorId}`);
			
			if (vendor.category === "CREDIT") {
				const net = Number(s.netPrice || 0);
				const balance = Number(vendor.account?.balance || 0);
				if (net > balance) {
					throw new Error(`Insufficient balance for vendor "${vendor.vendorName}". Available: ${balance}, Required: ${net}`);
				}
			}
		}

		/* ====================================================== 
		   2️⃣ TRANSACTION PHASE 
		====================================================== */

		const businessDate = saleDate ? new Date(saleDate) : new Date();

		const result = await prisma.$transaction(async (tx) => {
			/* Generate invoice */
			const invoiceNo = await generateNextSalesInvoiceNo(tx, businessDate);
			const invoice = await tx.salesInvoice.create({
				data: {
					invoiceNo,
					saleDate: businessDate,
					userId: req.user.id,
				}
			});

			/* In-memory balance tracking */
			const balances = new Map();
			vendors.forEach(v => balances.set(v.account.id, Number(v.account.balance || 0)));
			customers.forEach(c => balances.set(c.account.id, Number(c.account.balance || 0)));

			const getBal = (id) => balances.get(id) || 0;
			const setBal = (id, val) => balances.set(id, Number(val));

			let totalNet = 0, totalSell = 0, totalProfit = 0;

			/* Process each sale */
			for (const s of sales) {
				const vendor = vendorMap[s.vendorId];
				const net = Number(s.netPrice);
				const sell = Number(s.sellPrice);
				const paid = Number(s.paidAmount || 0);
				const profit = sell - net;

				/* Create sale record */
				const sale = await tx.sale.create({
					data: {
						invoiceId: invoice.id,
						airlineId: s.airlineId,
						vendorId: s.vendorId,
						customerId: s.customerId || null,
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
						paymentType: s.paymentType,
						paymentStatus: paid === sell ? "PAID" : paid > 0 ? "PARTIAL" : "DUE",
						status: "COMPLETED",
					}
				});

				/* Vendor ledger entry */
				const isDebitVendor = vendor.category === "DEBIT";
				const vendorDelta = isDebitVendor ? net : -net;
				const vendorBalAfter = getBal(vendor.account.id) + vendorDelta;

				await tx.ledgerEntry.create({
					data: {
						accountId: vendor.account.id,
						entryType: "SALE",
						debit: isDebitVendor ? net : 0,
						credit: isDebitVendor ? 0 : net,
						transactionDate: businessDate,
						saleId: sale.id,
						invoiceId: invoice.id,
						remarks: `Sale - Invoice ${invoiceNo}`
					}
				});

				await tx.account.update({
					where: { id: vendor.account.id },
					data: { balance: { increment: vendorDelta } }
				});

				setBal(vendor.account.id, vendorBalAfter);

				/* Customer ledger (if CREDIT payment) */
				if (String(s.paymentType).toUpperCase() === "CREDIT") {
					const cust = customerMap[s.customerId];
					if (!cust) throw new Error(`Customer not found: ${s.customerId}`);

					const custBalAfter = getBal(cust.account.id) + sell;

					await tx.ledgerEntry.create({
						data: {
							accountId: cust.account.id,
							entryType: "SALE",
							debit: sell,
							credit: 0,
							transactionDate: businessDate,
							saleId: sale.id,
							invoiceId: invoice.id,
							remarks: `Sale on credit - Invoice ${invoiceNo}`
						}
					});

					await tx.account.update({
						where: { id: cust.account.id },
						data: { balance: { increment: sell } }
					});

					setBal(cust.account.id, custBalAfter);

					/* Customer payment ledger (if partial/full payment made) */
					if (paid > 0) {
						const custBalAfterPayment = getBal(cust.account.id) - paid;

						await tx.ledgerEntry.create({
							data: {
								accountId: cust.account.id,
								entryType: "PAYMENT",
								debit: 0,
								credit: paid,
								transactionDate: businessDate,
								saleId: sale.id,
								invoiceId: invoice.id,
								remarks: `Payment received - Invoice ${invoiceNo}`
							}
						});

						await tx.account.update({
							where: { id: cust.account.id },
							data: { balance: { decrement: paid } }
						});

						setBal(cust.account.id, custBalAfterPayment);
					}
				}

				totalNet += net;
				totalSell += sell;
				totalProfit += profit;
			}

			/* Update invoice totals */
			await tx.salesInvoice.update({
				where: { id: invoice.id },
				data: { totalNet, totalSell, totalProfit }
			});

			return invoice;
		}, { timeout: 50000 });

		return res.status(201).json({
			success: true,
			message: "Sales processed successfully",
			data: result
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
		   1️⃣ LOAD EXISTING INVOICE
		====================================================== */
		const existingInvoice = await prisma.salesInvoice.findUnique({
			where: { id: invoiceId },
			include: {
				sales: {
					include: {
						vendor: { include: { account: true } },
						customer: { include: { account: true } },
					}
				}
			}
		});

		if (!existingInvoice) {
			return res.status(404).json({ success: false, error: "Invoice not found" });
		}

		const saleMap = new Map(existingInvoice.sales.map(s => [s.id, s]));

		// Validate all sale IDs exist in invoice
		for (const s of sales) {
			if (!s.id) throw new Error("Each sale must include 'id'");
			if (!saleMap.has(s.id)) throw new Error(`Sale not found in invoice: ${s.id}`);
		}

		/* ======================================================
		   2️⃣ FIND DELETED SALES (delete-by-omission)
		====================================================== */
		const payloadSaleIds = new Set(sales.map(s => s.id));
		const deletedSales = existingInvoice.sales.filter(s => !payloadSaleIds.has(s.id));

		/* ======================================================
		   3️⃣ PRELOAD VENDORS & CUSTOMERS
		====================================================== */
		const vendorIds = new Set();
		const customerIds = new Set();

		existingInvoice.sales.forEach(s => {
			if (s.vendorId) vendorIds.add(s.vendorId);
			if (s.customerId) customerIds.add(s.customerId);
		});

		sales.forEach(s => {
			if (s.vendorId) vendorIds.add(s.vendorId);
			if (s.customerId) customerIds.add(s.customerId);
		});

		const vendors = vendorIds.size ? await prisma.vendor.findMany({
			where: { id: { in: [...vendorIds] } },
			include: { account: true }
		}) : [];

		const customers = customerIds.size ? await prisma.customer.findMany({
			where: { id: { in: [...customerIds] } },
			include: { account: true }
		}) : [];

		const vendorMap = new Map(vendors.map(v => [v.id, v]));
		const customerMap = new Map(customers.map(c => [c.id, c]));

		const businessDate = saleDate ? new Date(saleDate) : new Date();

		/* ======================================================
		   4️⃣ TRANSACTION
		====================================================== */
		const result = await prisma.$transaction(async (tx) => {
			/* Update invoice header */
			await tx.salesInvoice.update({
				where: { id: invoiceId },
				data: { invoiceNo, saleDate: businessDate }
			});

			/* In-memory balance tracking */
			const balances = new Map();
			const touchedAccounts = new Set();

			const seedAccount = (acc) => {
				if (!acc || balances.has(acc.id)) return;
				balances.set(acc.id, Number(acc.balance || 0));
			};

			existingInvoice.sales.forEach(s => {
				seedAccount(s.vendor?.account);
				seedAccount(s.customer?.account);
			});

			sales.forEach(s => {
				const v = vendorMap.get(s.vendorId);
				if (v?.account) seedAccount(v.account);
				if (s.customerId) {
					const c = customerMap.get(s.customerId);
					if (c?.account) seedAccount(c.account);
				}
			});

			const getBal = (id) => balances.get(id) || 0;
			const setBal = (id, val) => {
				balances.set(id, Number(val));
				touchedAccounts.add(id);
			};

			/* ======================================================
			   4.1 DELETE SALES
			====================================================== */
			for (const sale of deletedSales) {
				const vendor = sale.vendor;
				const customer = sale.customer;
				const net = Number(sale.netPrice);
				const sell = Number(sale.sellPrice);
				const paid = Number(sale.paidAmount || 0);
				const wasCredit = String(sale.paymentType).toUpperCase() === "CREDIT";

				/* Reverse vendor ledger */
				if (vendor?.account) {
					const accId = vendor.account.id;
					const isDebit = vendor.category === "DEBIT";
					const delta = isDebit ? -net : net; // Reverse the original effect
					setBal(accId, getBal(accId) + delta);

					await tx.ledgerEntry.deleteMany({
						where: { saleId: sale.id, accountId: accId, entryType: "SALE" }
					});
				}

				/* Reverse customer ledger */
				if (wasCredit && customer?.account) {
					const accId = customer.account.id;
					setBal(accId, getBal(accId) - sell + paid); // Remove sale, restore payment

					await tx.ledgerEntry.deleteMany({
						where: { saleId: sale.id, accountId: accId, entryType: { in: ["SALE", "PAYMENT"] } }
					});
				}

				/* Delete sale record */
				await tx.sale.delete({ where: { id: sale.id } });
			}

			/* ======================================================
			   4.2 UPDATE EXISTING SALES
			====================================================== */
			let totalNet = 0, totalSell = 0, totalProfit = 0;

			for (const payload of sales) {
				const current = saleMap.get(payload.id);

				/* Parse values */
				const oldNet = Number(current.netPrice);
				const newNet = Number(payload.netPrice);
				const oldSell = Number(current.sellPrice);
				const newSell = Number(payload.sellPrice);
				const oldPaid = Number(current.paidAmount || 0);
				const newPaid = Number(payload.paidAmount || 0);

				/* Validate */
				if (isNaN(newNet) || isNaN(newSell)) throw new Error("Invalid prices");
				if (newNet < 0 || newSell < 0) throw new Error("Prices cannot be negative");
				if (newPaid < 0 || newPaid > newSell) throw new Error("Invalid paidAmount");

				const oldPaymentType = String(current.paymentType).toUpperCase();
				const newPaymentType = String(payload.paymentType || current.paymentType).toUpperCase();

				const vendorChanged = current.vendorId !== payload.vendorId;
				const customerChanged = (current.customerId || null) !== (payload.customerId || null);
				const netChanged = oldNet !== newNet;
				const sellChanged = oldSell !== newSell;
				const paidChanged = oldPaid !== newPaid;
				const paymentTypeChanged = oldPaymentType !== newPaymentType;

				const wasCredit = oldPaymentType === "CREDIT";
				const isCredit = newPaymentType === "CREDIT";

				if (isCredit && !payload.customerId) throw new Error("customerId required for CREDIT sales");

				/* ──────────────────────────────────────────────────
				   VENDOR HANDLING
				────────────────────────────────────────────────── */
				if (vendorChanged) {
					/* Remove old vendor */
					const oldVendor = vendorMap.get(current.vendorId);
					if (oldVendor?.account) {
						const accId = oldVendor.account.id;
						const isDebit = oldVendor.category === "DEBIT";
						const delta = isDebit ? -oldNet : oldNet;
						setBal(accId, getBal(accId) + delta);

						await tx.ledgerEntry.deleteMany({
							where: { saleId: current.id, accountId: accId, entryType: "SALE" }
						});
					}

					/* Add new vendor */
					const newVendor = vendorMap.get(payload.vendorId);
					if (!newVendor?.account) throw new Error("Vendor not found");

					const accId = newVendor.account.id;
					const isDebit = newVendor.category === "DEBIT";

					/* CREDIT vendor balance check */
					if (newVendor.category === "CREDIT" && newNet > getBal(accId)) {
						throw new Error(`Insufficient balance for vendor "${newVendor.vendorName}"`);
					}

					const delta = isDebit ? newNet : -newNet;
					setBal(accId, getBal(accId) + delta);

					await tx.ledgerEntry.create({
						data: {
							accountId: accId,
							entryType: "SALE",
							debit: isDebit ? newNet : 0,
							credit: isDebit ? 0 : newNet,
							transactionDate: businessDate,
							saleId: current.id,
							invoiceId,
							remarks: `Sale - Invoice ${invoiceNo}`
						}
					});
				} else if (netChanged) {
					/* Update existing vendor ledger */
					const vendor = vendorMap.get(current.vendorId);
					if (!vendor?.account) throw new Error("Vendor not found");

					const accId = vendor.account.id;
					const isDebit = vendor.category === "DEBIT";
					const delta = newNet - oldNet;

					/* CREDIT vendor balance check */
					if (vendor.category === "CREDIT" && delta > getBal(accId)) {
						throw new Error(`Insufficient balance for vendor "${vendor.vendorName}"`);
					}

					const netDelta = isDebit ? delta : -delta;
					setBal(accId, getBal(accId) + netDelta);

					await tx.ledgerEntry.updateMany({
						where: { saleId: current.id, accountId: accId, entryType: "SALE" },
						data: {
							debit: isDebit ? newNet : 0,
							credit: isDebit ? 0 : newNet,
							transactionDate: businessDate
						}
					});
				}

				/* ──────────────────────────────────────────────────
				   PAYMENT TYPE CHANGE HANDLING
				────────────────────────────────────────────────── */
				if (paymentTypeChanged || (isCredit && customerChanged)) {
					/* Remove old customer (if was credit) */
					if (wasCredit && current.customerId) {
						const oldCust = customerMap.get(current.customerId);
						if (oldCust?.account) {
							const accId = oldCust.account.id;
							setBal(accId, getBal(accId) - oldSell + oldPaid);

							await tx.ledgerEntry.deleteMany({
								where: { saleId: current.id, accountId: accId, entryType: { in: ["SALE", "PAYMENT"] } }
							});
						}
					}

					/* Add new customer (if now credit) */
					if (isCredit && payload.customerId) {
						const newCust = customerMap.get(payload.customerId);
						if (!newCust?.account) throw new Error("Customer not found");

						const accId = newCust.account.id;

						/* Create SALE ledger */
						setBal(accId, getBal(accId) + newSell);

						await tx.ledgerEntry.create({
							data: {
								accountId: accId,
								entryType: "SALE",
								debit: newSell,
								credit: 0,
								transactionDate: businessDate,
								saleId: current.id,
								invoiceId,
								remarks: `Sale on credit - Invoice ${invoiceNo}`
							}
						});

						/* Create PAYMENT ledger if paid */
						if (newPaid > 0) {
							setBal(accId, getBal(accId) - newPaid);

							await tx.ledgerEntry.create({
								data: {
									accountId: accId,
									entryType: "PAYMENT",
									debit: 0,
									credit: newPaid,
									transactionDate: businessDate,
									saleId: current.id,
									invoiceId,
									remarks: `Payment received - Invoice ${invoiceNo}`
								}
							});
						}
					}
				} else if (isCredit && !customerChanged) {
					/* Same customer, update sell/paid */
					const cust = customerMap.get(payload.customerId);
					if (!cust?.account) throw new Error("Customer not found");

					const accId = cust.account.id;

					/* Update sell price */
					if (sellChanged) {
						const delta = newSell - oldSell;
						setBal(accId, getBal(accId) + delta);

						await tx.ledgerEntry.updateMany({
							where: { saleId: current.id, accountId: accId, entryType: "SALE" },
							data: { debit: newSell, transactionDate: businessDate }
						});
					}

					/* Update paid amount */
					if (paidChanged) {
						const existingPayment = await tx.ledgerEntry.findFirst({
							where: { saleId: current.id, accountId: accId, entryType: "PAYMENT" }
						});

						if (newPaid > 0) {
							const delta = newPaid - oldPaid;
							setBal(accId, getBal(accId) - delta);

							if (existingPayment) {
								await tx.ledgerEntry.update({
									where: { id: existingPayment.id },
									data: { credit: newPaid, transactionDate: businessDate }
								});
							} else {
								await tx.ledgerEntry.create({
									data: {
										accountId: accId,
										entryType: "PAYMENT",
										debit: 0,
										credit: newPaid,
										transactionDate: businessDate,
										saleId: current.id,
										invoiceId,
										remarks: `Payment received - Invoice ${invoiceNo}`
									}
								});
							}
						} else if (newPaid === 0 && existingPayment) {
							setBal(accId, getBal(accId) + oldPaid);
							await tx.ledgerEntry.delete({ where: { id: existingPayment.id } });
						}
					}
				}

				/* ──────────────────────────────────────────────────
				   UPDATE SALE RECORD
				────────────────────────────────────────────────── */
				await tx.sale.update({
					where: { id: current.id },
					data: {
						airlineId: payload.airlineId,
						vendorId: payload.vendorId,
						customerId: payload.customerId || null,
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
						paymentType: payload.paymentType || current.paymentType,
						paymentStatus: newPaid === newSell ? "PAID" : newPaid > 0 ? "PARTIAL" : "DUE",
						remarks: payload.remarks || null
					}
				});

				totalNet += newNet;
				totalSell += newSell;
				totalProfit += (newSell - newNet);
			}

			/* ======================================================
			   4.3 PERSIST ACCOUNT BALANCES
			====================================================== */
			for (const accId of touchedAccounts) {
				await tx.account.update({
					where: { id: accId },
					data: { balance: getBal(accId) }
				});
			}

			/* ======================================================
			   4.4 UPDATE INVOICE TOTALS
			====================================================== */
			await tx.salesInvoice.update({
				where: { id: invoiceId },
				data: { totalNet, totalSell, totalProfit }
			});

			return { invoiceId, deletedSalesCount: deletedSales.length };
			},
			{ timeout: 20000, maxWait: 5000 }
		);

		return res.json({
			success: true,
			message: "Invoice updated successfully",
			data: result
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

router.delete("/single-sale/:saleId", authenticate, async (req, res) => {
    const { saleId } = req.params;

    try {
        await prisma.$transaction(async (tx) => {
            // 1. Fetch the sale with its parent invoice and account details
            const sale = await tx.sale.findUnique({
                where: { id: saleId },
                include: {
                    invoice: {
                        include: { sales: true }
                    },
                    vendor: { include: { account: true } },
                    customer: { include: { account: true } }
                }
            });

            if (!sale) throw new Error("Sale record not found");

            const net = Number(sale.netPrice);
            const sell = Number(sale.sellPrice);
            const paid = Number(sale.paidAmount || 0);
            const isCredit = String(sale.paymentType).toUpperCase() === "CREDIT";
            const invoiceId = sale.invoiceId;

            /* ──────────────────────────────────────────────────
               1️⃣ VENDOR REVERSAL
            ────────────────────────────────────────────────── */
            if (sale.vendor?.account) {
                const accId = sale.vendor.account.id;
                const isDebit = sale.vendor.category === "DEBIT";
                const delta = isDebit ? -net : net;

                // Wipe SALE ledger entries for this specific sale
                await tx.ledgerEntry.deleteMany({
                    where: {
                        saleId: sale.id,
                        accountId: accId,
                        entryType: "SALE"
                    }
                });

                // Update vendor balance
                await tx.account.update({
                    where: { id: accId },
                    data: { balance: { increment: delta } }
                });
            }

            /* ──────────────────────────────────────────────────
               2️⃣ CUSTOMER REVERSAL
            ────────────────────────────────────────────────── */
            if (isCredit && sale.customer?.account) {
                const accId = sale.customer.account.id;

                await tx.ledgerEntry.deleteMany({
                    where: {
                        saleId: sale.id,
                        accountId: accId,
                        entryType: { in: ["SALE", "PAYMENT"] }
                    }
                });

                const balanceDelta = -sell + paid;
                await tx.account.update({
                    where: { id: accId },
                    data: { balance: { increment: balanceDelta } }
                });
            }

            /* ──────────────────────────────────────────────────
               3️⃣ DELETE THE SALE
            ────────────────────────────────────────────────── */
            await tx.sale.delete({ where: { id: saleId } });

            /* ──────────────────────────────────────────────────
               4️⃣ UPDATE OR DELETE THE PARENT INVOICE
            ────────────────────────────────────────────────── */
            const remainingSales = sale.invoice.sales.filter(s => s.id !== saleId);

            if (remainingSales.length === 0) {
                // No sales left? Delete the invoice entirely
                await tx.salesInvoice.delete({ where: { id: invoiceId } });
            } else {
                // Recalculate invoice totals
                const newTotalNet = remainingSales.reduce((sum, s) => sum + s.netPrice, 0);
                const newTotalSell = remainingSales.reduce((sum, s) => sum + s.sellPrice, 0);
                const newTotalProfit = newTotalSell - newTotalNet;

                await tx.salesInvoice.update({
                    where: { id: invoiceId },
                    data: {
                        totalNet: newTotalNet,
                        totalSell: newTotalSell,
                        totalProfit: newTotalProfit
                    }
                });
            }
        });

        res.json({ success: true, message: "Sale deleted and invoice updated" });
    } catch (err) {
        console.error(err);
        res.status(400).json({ success: false, error: err.message });
    }
});

export default router;
