import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

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
router.get("/", authenticate, async (req, res) => {
	try {
		const { search } = req.query;

		const whereClause = search
			? {
				OR: [
					{
						invoiceNo: {
							contains: search,
							mode: "insensitive",
						},
					},
					{
						sales: {
							some: {
								OR: [
									{
										documentNo: {
											contains: search,
											mode: "insensitive",
										},
									},
									{
										remarks: {
											contains: search,
											mode: "insensitive",
										},
									},
								],
							},
						},
					},
				],
			}
			: {};

		const invoices = await prisma.salesInvoice.findMany({
			where: whereClause,
			orderBy: { createdAt: "desc" },
			include: {
				user: {
					select: { id: true, fullName: true, email: true },
				},
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
						isRefund: true,
						customerId: true,
						remarks: true,

						// ✅ FULL refund relation
						refund: true,

						vendor: {
							select: {
								vendorName: true,
								account: { select: { balance: true } },
							},
						},
						airline: {
							select: { airlineCode: true },
						},
						customer: {
							select: {
								customerName: true,
								phone: true,
								account: { select: { balance: true } },
							},
						},
					},
				},

			},
		});

		const data = invoices.map((inv) => ({
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

			sales: inv.sales.map((s) => ({
				id: s.id,

				vendorName: s.vendor?.vendorName || null,
				vendorBalance: s.vendor?.account?.balance ?? null,

				airlineCode: s.airline?.airlineCode || null,

				paymentType: s.paymentType,
				paymentStatus: s.paymentStatus,
				isRefund: s.isRefund,

				documentNo: s.documentNo,

				customerId: s.customerId || null,
				customerName: s.customer?.customerName || null,
				customerPhone: s.customer?.phone || null,
				customerBalance: s.customer?.account?.balance ?? null,

				netPrice: s.netPrice,
				sellPrice: s.sellPrice,
				profit: s.profit,
				remarks: s.remarks,
				status: s.status,

				// ✅ FULL refund object only when refunded
				refund: s.isRefund ? s.refund : null,
			})),


			createdAt: inv.createdAt,
		}));

		res.json({ success: true, data });
	} catch (err) {
		console.error(err);
		res.status(500).json({
			success: false,
			error: "Failed to fetch sales invoices",
		});
	}
});

router.get("/search", authenticate, async (req, res) => {
	try {
		const { documentNo } = req.query;

		if (!documentNo) {
			return res.status(400).json({
				success: false,
				error: "documentNo is required",
			});
		}

		/**
			* STEP 1️⃣
			* Find all sales matching document number
			* (including refunded ones)
			*/
		const sales = await prisma.sale.findMany({
			where: {
				documentNo: {
					contains: documentNo,
					mode: "insensitive",
				},
			},
			orderBy: {
				createdAt: "desc", // 🔥 MOST IMPORTANT
			},
			include: {
				airline: {
					select: { airlineCode: true },
				},
				vendor: {
					select: {
						vendorName: true,
						account: { select: { balance: true } },
					},
				},
				customer: {
					select: {
						customerName: true,
						phone: true,
						account: { select: { balance: true } },
					},
				},
				refund: true, // to know if refund record exists
			},
		});

		if (sales.length === 0) {
			return res.json({ success: true, data: [] });
		}

		/**
			* STEP 2️⃣
			* Group by documentNo and keep only latest sale
			*/
		const latestSaleByDoc = new Map();

		for (const sale of sales) {
			if (!latestSaleByDoc.has(sale.documentNo)) {
				latestSaleByDoc.set(sale.documentNo, sale);
			}
		}

		/**
			* STEP 3️⃣
			* Prepare response
			*/
		const data = Array.from(latestSaleByDoc.values()).map((s) => ({
			id: s.id,
			documentNo: s.documentNo,
			netPrice: s.netPrice,
			sellPrice: s.sellPrice,
			profit: s.profit,
			status: s.status,
			isRefund: s.isRefund,

			airlineCode: s.airline?.airlineCode || null,

			vendorName: s.vendor?.vendorName || null,
			vendorBalance: s.vendor?.account?.balance ?? null,

			customerName: s.customer?.customerName || null,
			customerPhone: s.customer?.phone || null,
			customerBalance: s.customer?.account?.balance ?? null,

			createdAt: s.createdAt,
			refundedAt: s.refund?.refundDate || null,
		}));

		res.json({ success: true, data });
	} catch (err) {
		console.error(err);
		res.status(500).json({
			success: false,
			error: "Failed to search sales",
		});
	}
});

/* ===========================
	GET INVOICE BY ID (WITH USER)
=========================== */
router.get("/:invoiceId", authenticate, async (req, res) => {
	try {
		const invoice = await prisma.salesInvoice.findUnique({
			where: { id: req.params.invoiceId },
			include: {
				user: {
					select: {
						id: true,
						fullName: true,
						email: true,
					},
				},
				sales: {
					include: {
						vendor: {
							select: {
								id: true,
								vendorName: true,
								category: true,
								account: { select: { balance: true } }, // ledger
							},
						},
						airline: {
							select: {
								id: true,
								airlineName: true,
								airlineCode: true,
							},
						},
						customer: {
							select: {
								id: true,
								customerName: true,
								customerType: true,
								phone: true,
								contactPerson: true,
								account: { select: { balance: true } }, // ledger
							},
						},
						refund: {
							select: {
								id: true,
								originalAmount: true,
								vendorRefundAmount: true,
								refundableAmount: true,
								refundFee: true,
								serviceCharges: true,
								refundReason: true,
								remarks: true,
								refundDate: true,
								createdAt: true,
							},
						},
					},
				},
			},
		});

		if (!invoice) {
			return res.status(404).json({
				success: false,
				error: "Invoice not found",
			});
		}

		res.json({
			success: true,
			data: {
				...invoice,
				salesCount: invoice.sales.length,
				createdById: invoice.user?.id || null,
				createdByName: invoice.user?.fullName || null,
				createdByEmail: invoice.user?.email || null,
			},
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({
			success: false,
			error: "Failed to fetch invoice",
		});
	}
});


router.get("/saleId/:saleId", authenticate, async (req, res) => {
  try {
    const sale = await prisma.sale.findUnique({
      where: {
        id: req.params.saleId,
      },
      include: {
        // 🔗 Parent invoice
        invoice: true,

        // ✈ Airline
        airline: true,

        // 🏢 Vendor
        vendor: true,

        // 👤 Customer (nullable)
        customer: true,

        // 💸 Refund master record (Refund table)
        refund: true,

        // 🔁 If this sale is a refund → original sale
        refundOfSale: {
          include: {
            invoice: true,
            airline: true,
            vendor: true,
            customer: true,
            refund: true,
          },
        },

        // 🔁 If this sale has refunds → child sales
        refunds: {
          include: {
            invoice: true,
            airline: true,
            vendor: true,
            customer: true,
            refund: true,
          },
        },
      },
    });

    if (!sale) {
      return res.status(404).json({
        success: false,
        error: "Sale not found",
      });
    }

    res.json({
      success: true,
      data: sale,
    });
  } catch (err) {
    console.error("Fetch single sale error:", err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch sale",
    });
  }
});


/* ===========================
	CREATE SALES (INVOICE HAS userId)
=========================== */
router.post("/", authenticate, async (req, res) => {
	const { invoiceNo, saleDate, sales = [], refunds = [] } = req.body;

	/* ======================
		BASIC VALIDATION
	====================== */
	if (!invoiceNo) {
		return res
			.status(400)
			.json({ success: false, error: "invoiceNo is required" });
	}

	if (!Array.isArray(sales) || !Array.isArray(refunds)) {
		return res.status(400).json({
			success: false,
			error: "sales and refunds must be arrays",
		});
	}

	if (sales.length === 0 && refunds.length === 0) {
		return res.status(400).json({
			success: false,
			error: "At least one sale or refund is required",
		});
	}

	try {
		/* ======================================================
			1️⃣ READ / VALIDATION PHASE (NO TRANSACTION)
		====================================================== */

		/* ---------- SALES VALIDATION ---------- */
		for (const s of sales) {
			const net = Number(s.netPrice);
			const sell = Number(s.sellPrice);
			const paid = Number(s.paidAmount || 0);
			const vat = Number(s.vatAmount || 0); // ✅ added
			const paxVat = Number(s.paxVat || 0); // ✅ NEW
			const miscCharges = Number(s.miscCharges || 0); // ✅ NEW

			if (Number.isNaN(net) || Number.isNaN(sell)) {
				throw new Error("netPrice and sellPrice must be numbers");
			}
			if (net < 0 || sell < 0) {
				throw new Error("netPrice/sellPrice cannot be negative");
			}
			if (paid < 0 || paid > sell) {
				throw new Error("Invalid paidAmount");
			}
			if (vat < 0) {
				throw new Error("vatAmount cannot be negative");
			}
			// ✅ NEW VALIDATIONS
			if (paxVat < 0) {
				throw new Error("paxVat cannot be negative");
			}
			if (miscCharges < 0) {
				throw new Error("miscCharges cannot be negative");
			}

			if (String(s.paymentType).toUpperCase() === "CREDIT" && !s.customerId) {
				throw new Error("customerId required for CREDIT sales");
			}
		}

		/* ---------- REFUND VALIDATION ---------- */
		for (const r of refunds) {
			if (!r.saleId) throw new Error("saleId required for refund");

			const amt = Number(r.refundableAmount);
			if (!amt || amt <= 0) {
				throw new Error("refundableAmount must be positive");
			}

			const fee = Number(r.refundFee || 0);
			const sc = Number(r.serviceCharges || 0);

			if (fee < 0 || sc < 0) {
				throw new Error("refundFee/serviceCharges cannot be negative");
			}
		}

		/* ---------- LOAD ORIGINAL SALES ---------- */
		const refundSaleIds = [...new Set(refunds.map((r) => r.saleId))];

		const originalSales = refundSaleIds.length
			? await prisma.sale.findMany({
					where: { id: { in: refundSaleIds } },
					include: {
						vendor: { include: { account: true } },
						customer: { include: { account: true } },
					},
			  })
			: [];

		const originalSaleMap = Object.fromEntries(
			originalSales.map((s) => [s.id, s])
		);

		/* ---------- PRELOAD REFUND TOTALS (FIX) ---------- */
		const refundSums = refundSaleIds.length
			? await prisma.sale.groupBy({
					by: ["refundOfSaleId"],
					where: {
						isRefund: true,
						refundOfSaleId: { in: refundSaleIds },
					},
					_sum: { sellPrice: true },
			  })
			: [];

		const refundSumMap = Object.fromEntries(
			refundSums.map((r) => [
				r.refundOfSaleId,
				Math.abs(Number(r._sum.sellPrice || 0)),
			])
		);

		for (const r of refunds) {
			const orig = originalSaleMap[r.saleId];
			if (!orig) throw new Error(`Original sale not found: ${r.saleId}`);
			if (orig.isRefund) throw new Error("Cannot refund a refund");

			const alreadyRefunded = refundSumMap[r.saleId] || 0;

			if (
				Number(r.refundableAmount) >
				Number(orig.sellPrice) - alreadyRefunded
			) {
				throw new Error("Refund exceeds remaining refundable amount");
			}
		}

		/* ---------- LOAD VENDORS & CUSTOMERS ---------- */
		const vendorIds = [
			...new Set(sales.map((s) => s.vendorId).filter(Boolean)),
		];
		const customerIds = [
			...new Set(
				sales
					.filter((s) => String(s.paymentType).toUpperCase() === "CREDIT")
					.map((s) => s.customerId)
			),
		];

		const vendors = vendorIds.length
			? await prisma.vendor.findMany({
				where: { id: { in: vendorIds } },
				include: { account: true },
			})
			: [];

		const customers = customerIds.length
			? await prisma.customer.findMany({
				where: { id: { in: customerIds } },
				include: { account: true },
			})
			: [];

		const vendorMap = Object.fromEntries(vendors.map((v) => [v.id, v]));
		const customerMap = Object.fromEntries(customers.map((c) => [c.id, c]));

		/* ---------- DEBIT VENDOR BALANCE VALIDATION ---------- */
		for (const s of sales) {
			const vendor = vendorMap[s.vendorId];
			if (!vendor || vendor.category !== "CREDIT") continue;

			const net = Number(s.netPrice || 0);
			const balance = Number(vendor.account?.balance || 0);

			if (net > balance) {
				throw new Error(
					`Insufficient balance for vendor "${vendor.vendorName}". Available: ${balance}, Required: ${net}`
				);
			}
		}

		/* ======================================================
			2️⃣ WRITE PHASE (TRANSACTION)
		====================================================== */

		const businessDate = saleDate ? new Date(saleDate) : new Date();

		const result = await prisma.$transaction(
			async (tx) => {
			const invoice = await tx.salesInvoice.create({
				data: {
					invoiceNo,
					saleDate: businessDate,
					userId: req.user.id,
				},
			});

				/* ---------- IN-MEMORY BALANCES ---------- */
				const balances = new Map();
				const initBal = (acc) =>
					acc &&
					!balances.has(acc.id) &&
					balances.set(acc.id, Number(acc.balance || 0));

				vendors.forEach((v) => initBal(v.account));
				customers.forEach((c) => initBal(c.account));
				originalSales.forEach((s) => {
					initBal(s.vendor?.account);
					initBal(s.customer?.account);
				});

				const getBal = (id) => balances.get(id) || 0;
				const setBal = (id, v) => balances.set(id, Number(v));

			let totalNet = 0;
			let totalSell = 0;
			let totalProfit = 0;

			/* ======================
				SALES
			====================== */
			for (const s of sales) {
				const vendor = vendorMap[s.vendorId];
				const net = Number(s.netPrice);
				const sell = Number(s.sellPrice);
				const paid = Number(s.paidAmount || 0);
				const vat = Number(s.vatAmount || 0);
				const paxVat = Number(s.paxVat || 0); // ✅ NEW
				const miscCharges = Number(s.miscCharges || 0); // ✅ NEW
				const profit = sell - net;

				const sale = await tx.sale.create({
					data: {
						invoiceId: invoice.id,
						airlineId: s.airlineId,
						vendorId: s.vendorId,
						customerId: s.customerId || null,
						documentNo: s.documentNo || null,

						// ✅ NEW FIELDS
						pnr: s.pnr || null,
						routeType: s.routeType || null,
						tripType: s.tripType || "Oneway",
						departDate: s.departDate ? new Date(s.departDate) : null,
						arrivalDate: s.arrivalDate ? new Date(s.arrivalDate) : null,
						paxVat: paxVat,
						miscCharges: miscCharges,

						paxName: s.paxName || null,
						destinations: s.destinations || null,
						vatAmount: vat,

						netPrice: net,
						sellPrice: sell,
						profit,
						paidAmount: paid,
						paymentType: s.paymentType,
						paymentStatus:
							paid === sell ? "PAID" : paid > 0 ? "PARTIAL" : "DUE",
						status: "COMPLETED",
						isRefund: false,
					},
				});

					const isDebitVendor = vendor.category === "DEBIT";
					const vendorBalAfter =
						getBal(vendor.account.id) + (isDebitVendor ? net : -net);

					await tx.ledgerEntry.create({
						data: {
							accountId: vendor.account.id,
							entryType: "SALE",
							debit: net,
							credit: 0,
							balanceAfter: vendorBalAfter,
							transactionDate: businessDate,
							saleId: sale.id,
							invoiceId: invoice.id,
						},
					});

					await tx.account.update({
						where: { id: vendor.account.id },
						data: { balance: vendorBalAfter },
					});

					setBal(vendor.account.id, vendorBalAfter);

					if (String(s.paymentType).toUpperCase() === "CREDIT") {
						const cust = customerMap[s.customerId];
						const custBalAfter = getBal(cust.account.id) + sell;

						await tx.ledgerEntry.create({
							data: {
								accountId: cust.account.id,
								entryType: "SALE",
								debit: sell,
								credit: 0,
								balanceAfter: custBalAfter,
								transactionDate: businessDate,
								saleId: sale.id,
								invoiceId: invoice.id,
							},
						});

						await tx.account.update({
							where: { id: cust.account.id },
							data: { balance: custBalAfter },
						});

						setBal(cust.account.id, custBalAfter);

						/* ---------- PAYMENT LEDGER ENTRY ---------- */
						if (paid > 0) {
							const custBalAfterPayment = getBal(cust.account.id) - paid;

							await tx.ledgerEntry.create({
								data: {
									accountId: cust.account.id,
									entryType: "PAYMENT",
									debit: 0,
									credit: paid,
									balanceAfter: custBalAfterPayment,
									transactionDate: businessDate,
									saleId: sale.id,
									invoiceId: invoice.id,
								},
							});

							await tx.account.update({
								where: { id: cust.account.id },
								data: { balance: custBalAfterPayment },
							});

							setBal(cust.account.id, custBalAfterPayment);
						}
					}

				totalNet += net;
				totalSell += sell;
				totalProfit += profit;
			}

				/* ======================
					REFUNDS (UNCHANGED LOGIC)
				====================== */
				for (const r of refunds) {
					const orig = originalSaleMap[r.saleId];

					/* ======================================================
					   🔁 REVERSE CUSTOMER PAYMENT (ON REFUND)
					   - Delete PAYMENT ledger
					   - Restore paidAmount back to customer balance
					====================================================== */
					if (
						String(orig.paymentType).toUpperCase() === "CREDIT" &&
						orig.customer?.account &&
						Number(orig.paidAmount || 0) > 0
					) {
						const paidAmount = Number(orig.paidAmount);
						const custAccId = orig.customer.account.id;

						const prevCustBal = getBal(custAccId);

						// Restore paid amount back to customer balance
						const custBalAfterRestore = prevCustBal + paidAmount;

						// Delete PAYMENT ledger entries for ORIGINAL sale
						await tx.ledgerEntry.deleteMany({
							where: {
								saleId: orig.id,
								entryType: "PAYMENT",
								accountId: custAccId,
							},
						});

						// Update customer account balance
						await tx.account.update({
							where: { id: custAccId },
							data: { balance: custBalAfterRestore },
						});

						setBal(custAccId, custBalAfterRestore);
					}

					// 👇 existing refund logic continues unchanged
					const baseNet = Number(orig.netPrice);
					const baseSell = Number(orig.sellPrice);
					const fee = Number(r.refundFee || 0);
					const sc = Number(r.serviceCharges || 0);

					const customerRefund = baseNet - fee - sc;
					const vendorRefund = baseNet - fee;

					const refundSale = await tx.sale.create({
						data: {
							invoiceId: invoice.id,
							airlineId: orig.airlineId,
							vendorId: orig.vendorId,
							customerId: orig.customerId,
							documentNo: orig.documentNo,
							netPrice: -baseNet,
							sellPrice: -baseSell,
							profit: 0,
							paymentType: orig.paymentType,
							paidAmount: 0,
							paymentStatus: "PAID",
							status: "REFUNDED",
							isRefund: true,
							refundOfSaleId: orig.id,
						},
					});

					const refund = await tx.refund.create({
						data: {
							saleId: refundSale.id,
							originalAmount: baseNet,
							refundableAmount: customerRefund,
							refundFee: fee,
							serviceCharges: sc,
							remarks: r.remarks || null,
							refundDate: businessDate,
						},
					});


					/* ---- VENDOR REFUND LEDGER (FIXED) ---- */
					const isDebitVendor = orig.vendor.category === "DEBIT";
					const prevVendorBal = getBal(orig.vendor.account.id);

					// ✅ CREDIT entry for refund (ALWAYS)
					const vendorBalAfter = isDebitVendor
						? prevVendorBal - vendorRefund // DEBIT vendor → subtract
						: prevVendorBal + vendorRefund; // CREDIT vendor → add

					await tx.ledgerEntry.create({
						data: {
							accountId: orig.vendor.account.id,
							entryType: "REFUNDED",
							debit: 0,
							credit: vendorRefund,
							balanceAfter: vendorBalAfter,
							transactionDate: businessDate,
							saleId: refundSale.id,
							refundId: refund.id,
							invoiceId: invoice.id,
						},
					});

					await tx.account.update({
						where: { id: orig.vendor.account.id },
						data: { balance: vendorBalAfter },
					});

					setBal(orig.vendor.account.id, vendorBalAfter);

					/* ---- CUSTOMER REFUND LEDGER (FIXED) ---- */
					if (
						String(orig.paymentType).toUpperCase() === "CREDIT" &&
						orig.customer?.account
					) {
						const prevCustBal = getBal(orig.customer.account.id);

						// ✅ CREDIT customer, subtract balance
						const custBalAfter = prevCustBal - customerRefund;

						await tx.ledgerEntry.create({
							data: {
								accountId: orig.customer.account.id,
								entryType: "REFUNDED",
								debit: 0,
								credit: customerRefund,
								balanceAfter: custBalAfter,
								transactionDate: businessDate,
								saleId: refundSale.id,
								refundId: refund.id,
								invoiceId: invoice.id,
							},
						});

						await tx.account.update({
							where: { id: orig.customer.account.id },
							data: { balance: custBalAfter },
						});

						setBal(orig.customer.account.id, custBalAfter);
					}

					totalNet -= baseNet;
					totalSell -= baseSell;
				}

			await tx.salesInvoice.update({
				where: { id: invoice.id },
				data: { totalNet, totalSell, totalProfit },
			});

			return invoice;
			},
			{ timeout: 50000 }
		);

		return res.status(201).json({
			success: true,
			message: "Sales & refunds processed successfully",
			data: result,
		});
	} catch (err) {
		console.error(err);
		return res.status(400).json({ success: false, error: err.message });
	}
});


router.put("/:invoiceId", authenticate, async (req, res) => {
	const { invoiceId } = req.params;
	const { invoiceNo, saleDate, sales = [], refunds = [] } = req.body;

	/* ======================
		BASIC VALIDATION
	====================== */
	if (!invoiceNo) {
		return res.status(400).json({ success: false, error: "invoiceNo is required" });
	}

	if (!Array.isArray(sales)) {
		return res.status(400).json({ success: false, error: "sales must be an array" });
	}

	if (!Array.isArray(refunds)) {
		return res.status(400).json({ success: false, error: "refunds must be an array" });
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
						refund: true,
					},
				},
			},
		});

		if (!existingInvoice) {
			return res.status(404).json({ success: false, error: "Invoice not found" });
		}

		// if (sales.length === 0) {
		// 	return res.status(400).json({
		// 		success: false,
		// 		error: "sales cannot be empty in this endpoint",
		// 	});
		// }

		const saleMap = new Map(existingInvoice.sales.map((s) => [s.id, s]));

		for (const s of sales) {
			if (!s.id) throw new Error("Each sale in PUT payload must include 'id'");
			if (!saleMap.has(s.id)) throw new Error(`Sale not found in invoice: ${s.id}`);
		}

		/* ======================================================
			2️⃣ FIND DELETED SALES (DELETE-BY-OMISSION)
			+ 🔐 protect refunded sales
		====================================================== */
		const payloadSaleIds = new Set(sales.map((s) => s.id));

		// 👉 refunded sales must NEVER be considered deleted
		const refundIds = refunds.map((r) => r?.id).filter(Boolean);

		const refundRows =
			refundIds.length > 0
				? await prisma.refund.findMany({
						where: { id: { in: refundIds } },
						include: {
							sale: {
								include: {
									vendor: { include: { account: true } },
									customer: { include: { account: true } },
								},
							},
						},
				  })
				: [];

		for (const r of refundRows) {
			payloadSaleIds.add(r.saleId);
		}

		const deletedSales = existingInvoice.sales.filter(
			(s) => !payloadSaleIds.has(s.id)
		);

		/* ======================================================
			3️⃣ PRELOAD VENDORS & CUSTOMERS
		====================================================== */
		const vendorIds = new Set();
		const customerIds = new Set();

		for (const s of existingInvoice.sales) {
			if (s.vendorId) vendorIds.add(s.vendorId);
			if (s.customerId) customerIds.add(s.customerId);
		}

		for (const s of sales) {
			if (s.vendorId) vendorIds.add(s.vendorId);
			if (s.customerId) customerIds.add(s.customerId);
		}

		const vendors = vendorIds.size
			? await prisma.vendor.findMany({
					where: { id: { in: [...vendorIds] } },
					include: { account: true },
			  })
			: [];

		const customers = customerIds.size
			? await prisma.customer.findMany({
					where: { id: { in: [...customerIds] } },
					include: { account: true },
			  })
			: [];

		const vendorMap = new Map(vendors.map((v) => [v.id, v]));
		const customerMap = new Map(customers.map((c) => [c.id, c]));

		const businessDate = saleDate ? new Date(saleDate) : new Date();

		/* ======================================================
			4️⃣ TRANSACTION
		====================================================== */
		const result = await prisma.$transaction(
			async (tx) => {
			await tx.salesInvoice.update({
				where: { id: invoiceId },
				data: { invoiceNo, saleDate: businessDate },
			});

				/* ======================================================
					4.1 IN-MEMORY BALANCES (UNCHANGED)
				====================================================== */
			const balances = new Map();
			const touchedAccounts = new Set();

				const seedAccount = (acc) => {
					if (!acc) return;
					if (!balances.has(acc.id)) balances.set(acc.id, Number(acc.balance || 0));
			};

			for (const s of existingInvoice.sales) {
					seedAccount(s.vendor?.account);
					seedAccount(s.customer?.account);
				}

				for (const s of sales) {
					const v = vendorMap.get(s.vendorId);
					if (v?.account) seedAccount(v.account);
					if (s.customerId) {
						const c = customerMap.get(s.customerId);
						if (c?.account) seedAccount(c.account);
					}
			}

			const getBal = (id) => Number(balances.get(id) || 0);
			const setBal = (id, val) => {
				balances.set(id, Number(val));
				touchedAccounts.add(id);
			};

				/* ======================================================
					🔵 REFUND UPDATE (BY refundId ONLY) - FIXED
				====================================================== */
				for (const payloadRefund of refunds) {
					if (!payloadRefund.id) {
						throw new Error("refundId is required in refund payload");
					}

					const refund = await tx.refund.findUnique({
						where: { id: payloadRefund.id },
						include: {
							sale: {
								include: {
									vendor: { include: { account: true } },
									customer: { include: { account: true } },
								},
							},
						},
					});

					if (!refund) {
						throw new Error(`Refund not found: ${payloadRefund.id}`);
					}

					const sale = refund.sale;

					/* ---- OLD VALUES ---- */
					const oldRefundFee = Number(refund.refundFee || 0);
					const oldServiceCharges = Number(refund.serviceCharges || 0);
					const oldOriginalAmount = Number(refund.originalAmount || 0);

					const oldVendorRefund = oldOriginalAmount - oldRefundFee;
					const oldCustomerRefund = oldOriginalAmount - oldRefundFee - oldServiceCharges;

					/* ---- NEW VALUES ---- */
					const newRefundFee = Number(payloadRefund.refundFee ?? oldRefundFee);
					const newServiceCharges = Number(payloadRefund.serviceCharges ?? oldServiceCharges);
					const newOriginalAmount = Number(payloadRefund.originalAmount ?? oldOriginalAmount);

					const newVendorRefund = newOriginalAmount - newRefundFee;
					const newCustomerRefund = newOriginalAmount - newRefundFee - newServiceCharges;

					/* ---- DELTA CALCULATIONS ---- */
					const vendorDelta = newVendorRefund - oldVendorRefund;
					const customerDelta = newCustomerRefund - oldCustomerRefund;

					/* ---- Update refund row ---- */
					await tx.refund.update({
						where: { id: refund.id },
						data: {
							originalAmount: newOriginalAmount,
							vendorRefundAmount: newVendorRefund,
							refundableAmount: newCustomerRefund,
							refundFee: newRefundFee,
							serviceCharges: newServiceCharges,
							refundReason: payloadRefund.refundReason ?? refund.refundReason,
							remarks: payloadRefund.remarks ?? refund.remarks,
							refundDate: payloadRefund.refundDate
								? new Date(payloadRefund.refundDate)
								: refund.refundDate,
						},
					});

					/* ---- UPDATE VENDOR REFUND LEDGER ---- */
					if (sale.vendor?.account) {
						const vendorLedger = await tx.ledgerEntry.findFirst({
							where: {
								saleId: sale.id,
								accountId: sale.vendor.account.id,
								entryType: "REFUNDED",
							},
						});

						if (vendorLedger) {
							const isDebitVendor = sale.vendor.category === "DEBIT";
							const prevBal = getBal(sale.vendor.account.id);

							// Adjust balance based on delta
							const vendorBalAfter = isDebitVendor
								? prevBal - vendorDelta
								: prevBal + vendorDelta;

							await tx.ledgerEntry.update({
								where: { id: vendorLedger.id },
								data: {
									debit: 0,
									credit: newVendorRefund,
									balanceAfter: vendorBalAfter,
									transactionDate: businessDate,
								},
							});

							setBal(sale.vendor.account.id, vendorBalAfter);
						}
					}

					/* ---- UPDATE CUSTOMER REFUND LEDGER ---- */
					if (sale.customer?.account && String(sale.paymentType).toUpperCase() === "CREDIT") {
						const customerLedger = await tx.ledgerEntry.findFirst({
							where: {
								saleId: sale.id,
								accountId: sale.customer.account.id,
								entryType: "REFUNDED",
							},
						});

						if (customerLedger) {
							const prevBal = getBal(sale.customer.account.id);

							// Customer refund reduces their balance
							const customerBalAfter = prevBal - customerDelta;

							await tx.ledgerEntry.update({
								where: { id: customerLedger.id },
								data: {
									debit: 0,
									credit: newCustomerRefund,
									balanceAfter: customerBalAfter,
									transactionDate: businessDate,
								},
							});

							setBal(sale.customer.account.id, customerBalAfter);
						}
					}
				}

				/* ======================================================
					4.2 HANDLE DELETED SALES
				====================================================== */
			for (const s of deletedSales) {
				const refundExists = await tx.refund.findFirst({
					where: { saleId: s.id },
				});

				if (refundExists) {
						throw new Error(
							`Sale ${s.id} cannot be deleted because a refund exists`
						);
				}

				await tx.sale.delete({ where: { id: s.id } });
			}

				/* ======================================================
					4.3 PROCESS EDITED/KEPT SALES
				====================================================== */
			let totalNet = 0;
			let totalSell = 0;
			let totalProfit = 0;

			for (const payload of sales) {
				const current = saleMap.get(payload.id);

					// Normalize & validate
				const oldNet = Number(current.netPrice || 0);
				const newNet = Number(payload.netPrice);
				const oldSell = Number(current.sellPrice || 0);
				const newSell = Number(payload.sellPrice);
				const oldPaid = Number(current.paidAmount || 0);
				const newPaid = Number(payload.paidAmount || 0);
				const newVat = Number(payload.vatAmount || 0);
				const newPaxVat = Number(payload.paxVat || 0); // ✅ NEW
				const newMiscCharges = Number(payload.miscCharges || 0); // ✅ NEW

				if (newVat < 0) throw new Error("vatAmount cannot be negative");
				// ✅ NEW VALIDATIONS
				if (newPaxVat < 0) throw new Error("paxVat cannot be negative");
				if (newMiscCharges < 0) throw new Error("miscCharges cannot be negative");

					if (Number.isNaN(newNet) || Number.isNaN(newSell)) {
						throw new Error("netPrice and sellPrice must be numbers");
					}
					if (newNet < 0 || newSell < 0) {
						throw new Error("netPrice/sellPrice cannot be negative");
					}
					if (newPaid < 0 || newPaid > newSell) {
						throw new Error("Invalid paidAmount");
					}

					const oldPaymentType = String(current.paymentType || "").toUpperCase();
					const newPaymentType = String(payload.paymentType || current.paymentType).toUpperCase();

					const vendorChanged = current.vendorId !== payload.vendorId;
					const customerChanged = (current.customerId || null) !== (payload.customerId || null);
					const netChanged = oldNet !== newNet;
					const sellChanged = oldSell !== newSell;
					const paidChanged = oldPaid !== newPaid;
					const paymentTypeChanged = oldPaymentType !== newPaymentType;

					const wasCredit = oldPaymentType === "CREDIT";
					const isCredit = newPaymentType === "CREDIT";

					if (isCredit && !payload.customerId) {
						throw new Error("customerId required for CREDIT sales");
					}

					/* ==========================
						VENDOR REMOVE (if changed)
					========================== */
					if (vendorChanged) {
						const oldVendor = vendorMap.get(current.vendorId);
						if (!oldVendor || !oldVendor.account) throw new Error("Old vendor not found");

						const oldAccId = oldVendor.account.id;
						const prevBal = getBal(oldAccId);

						const restored =
							oldVendor.category === "CREDIT" ? prevBal + oldNet : prevBal - oldNet;

						setBal(oldAccId, restored);

						await tx.ledgerEntry.deleteMany({
							where: {
								invoiceId,
								saleId: current.id,
								accountId: oldAccId,
								entryType: "SALE",
							},
						});
					}

					/* ==========================
						VENDOR APPLY (if changed or net changed)
					========================== */
					if (vendorChanged || netChanged) {
						const newVendor = vendorMap.get(payload.vendorId);
						if (!newVendor || !newVendor.account) throw new Error("New vendor not found");

						const accId = newVendor.account.id;
						const curBal = getBal(accId);

						if (newVendor.category === "CREDIT") {
							const effectiveBalance = vendorChanged ? curBal : curBal + oldNet;
							if (newNet > effectiveBalance) {
								throw new Error(`Insufficient balance for vendor "${newVendor.vendorName}"`);
							}
						}

						const deltaNet = vendorChanged ? newNet : (newNet - oldNet);

						const vendorBalAfter =
							newVendor.category === "CREDIT" ? curBal - deltaNet : curBal + deltaNet;

						if (vendorChanged) {
							await tx.ledgerEntry.create({
								data: {
									accountId: accId,
									entryType: "SALE",
									debit: newNet,
									credit: 0,
									balanceAfter: vendorBalAfter,
									transactionDate: businessDate,
									saleId: current.id,
									invoiceId,
								},
							});
						} else {
							await tx.ledgerEntry.updateMany({
								where: {
									invoiceId,
									saleId: current.id,
									accountId: accId,
									entryType: "SALE",
								},
								data: {
									debit: newNet,
									credit: 0,
									balanceAfter: vendorBalAfter,
									transactionDate: businessDate,
								},
							});
						}

						setBal(accId, vendorBalAfter);
					}

					/* ==========================
						PAYMENT TYPE CHANGE HANDLING
					========================== */

					/* ---- SCENARIO 1: CREDIT → CASH/BANK ---- */
					if (wasCredit && !isCredit && current.customerId) {
						const oldCustomer = customerMap.get(current.customerId);
						if (oldCustomer?.account) {
							const accId = oldCustomer.account.id;
							const prevBal = getBal(accId);

							// Reverse customer balance: remove sell price, add back paid amount
							const balAfterRemoval = prevBal - oldSell + oldPaid;

							// Delete SALE ledger entry
							await tx.ledgerEntry.deleteMany({
								where: {
									invoiceId,
									saleId: current.id,
									accountId: accId,
									entryType: "SALE",
								},
							});

							// Delete PAYMENT ledger entry if exists
							await tx.ledgerEntry.deleteMany({
								where: {
									invoiceId,
									saleId: current.id,
									accountId: accId,
									entryType: "PAYMENT",
								},
							});

							setBal(accId, balAfterRemoval);
						}
					}

					/* ---- SCENARIO 2: CASH/BANK → CREDIT ---- */
					if (!wasCredit && isCredit) {
						const newCustomer = customerMap.get(payload.customerId);
						if (!newCustomer?.account) throw new Error("Customer not found");

						const accId = newCustomer.account.id;
						const curBal = getBal(accId);

						// Add sell price to customer balance
						const balAfterSale = curBal + newSell;

						// Create SALE ledger entry
						await tx.ledgerEntry.create({
							data: {
								accountId: accId,
								entryType: "SALE",
								debit: newSell,
								credit: 0,
								balanceAfter: balAfterSale,
								transactionDate: businessDate,
								saleId: current.id,
								invoiceId,
							},
						});

						setBal(accId, balAfterSale);

						// Create PAYMENT ledger entry if there's paid amount
						if (newPaid > 0) {
							const balAfterPayment = balAfterSale - newPaid;

							await tx.ledgerEntry.create({
								data: {
									accountId: accId,
									entryType: "PAYMENT",
									debit: 0,
									credit: newPaid,
									balanceAfter: balAfterPayment,
									transactionDate: businessDate,
									saleId: current.id,
									invoiceId,
								},
							});

							setBal(accId, balAfterPayment);
						}
					}

					/* ---- SCENARIO 3: CREDIT → CREDIT (Update existing) ---- */
					if (wasCredit && isCredit) {
						// Handle customer change
						if (customerChanged) {
							// Remove old customer
							if (current.customerId) {
								const oldCustomer = customerMap.get(current.customerId);
								if (!oldCustomer || !oldCustomer.account) throw new Error("Old customer not found");

								const accId = oldCustomer.account.id;
								const prevBal = getBal(accId);

								// Remove old sell and add back old paid
								setBal(accId, prevBal - oldSell + oldPaid);

								await tx.ledgerEntry.deleteMany({
									where: {
										invoiceId,
										saleId: current.id,
										accountId: accId,
										entryType: "SALE",
									},
								});

								await tx.ledgerEntry.deleteMany({
									where: {
										invoiceId,
										saleId: current.id,
										accountId: accId,
										entryType: "PAYMENT",
									},
								});
							}

							// Add new customer
							const newCustomer = customerMap.get(payload.customerId);
							if (!newCustomer?.account) throw new Error("Customer not found");

							const accId = newCustomer.account.id;
							const curBal = getBal(accId);

							// Add new sell
							const balAfterSale = curBal + newSell;

							await tx.ledgerEntry.create({
								data: {
									accountId: accId,
									entryType: "SALE",
									debit: newSell,
									credit: 0,
									balanceAfter: balAfterSale,
									transactionDate: businessDate,
									saleId: current.id,
									invoiceId,
								},
							});

							setBal(accId, balAfterSale);

							// Add payment if exists
							if (newPaid > 0) {
								const balAfterPayment = balAfterSale - newPaid;

								await tx.ledgerEntry.create({
									data: {
										accountId: accId,
										entryType: "PAYMENT",
										debit: 0,
										credit: newPaid,
										balanceAfter: balAfterPayment,
										transactionDate: businessDate,
										saleId: current.id,
										invoiceId,
									},
								});

								setBal(accId, balAfterPayment);
							}
						} else {
							// Same customer, handle sell/paid changes
							const cust = customerMap.get(payload.customerId);
							if (!cust?.account) throw new Error("Customer not found");

							const accId = cust.account.id;

							// Handle sell price change
							if (sellChanged) {
								const curBal = getBal(accId);
								const deltaSell = newSell - oldSell;
								const balAfterSale = curBal + deltaSell;

								await tx.ledgerEntry.updateMany({
									where: {
										invoiceId,
										saleId: current.id,
										accountId: accId,
										entryType: "SALE",
									},
									data: {
										debit: newSell,
										credit: 0,
										balanceAfter: balAfterSale,
										transactionDate: businessDate,
									},
								});

								setBal(accId, balAfterSale);
							}

							// Handle paid amount change
							if (paidChanged) {
								const curBal = getBal(accId);

								const existingPaymentLedger = await tx.ledgerEntry.findFirst({
									where: {
										saleId: current.id,
										accountId: accId,
										entryType: "PAYMENT",
									},
								});

								if (newPaid > 0) {
									const deltaPaid = newPaid - oldPaid;
									const balAfterPayment = curBal - deltaPaid;

									if (existingPaymentLedger) {
										// Update existing payment ledger
										await tx.ledgerEntry.update({
											where: { id: existingPaymentLedger.id },
											data: {
												credit: newPaid,
												balanceAfter: balAfterPayment,
												transactionDate: businessDate,
											},
										});
									} else {
										// Create new payment ledger
										await tx.ledgerEntry.create({
											data: {
												accountId: accId,
												entryType: "PAYMENT",
												debit: 0,
												credit: newPaid,
												balanceAfter: balAfterPayment,
												transactionDate: businessDate,
												saleId: current.id,
												invoiceId,
											},
										});
									}

									setBal(accId, balAfterPayment);
								} else if (newPaid === 0 && existingPaymentLedger) {
									// Delete payment ledger if paid becomes 0
									const balAfterRemoval = curBal + oldPaid;

									await tx.ledgerEntry.delete({
										where: { id: existingPaymentLedger.id },
									});

									setBal(accId, balAfterRemoval);
								}
							}
						}
					}

					/* ==========================
						UPDATE SALE ROW (new baseline)
					========================== */
				await tx.sale.update({
					where: { id: current.id },
					data: {
						airlineId: payload.airlineId,
						vendorId: payload.vendorId,
						customerId: payload.customerId || null,
						documentNo: payload.documentNo || null,

						// ✅ NEW FIELDS
						pnr: payload.pnr ?? current.pnr,
						routeType: payload.routeType ?? current.routeType,
						tripType: payload.tripType ?? current.tripType,
						departDate: payload.departDate ? new Date(payload.departDate) : current.departDate,
						arrivalDate: payload.arrivalDate ? new Date(payload.arrivalDate) : current.arrivalDate,
						paxVat: newPaxVat,
						miscCharges: newMiscCharges,

						paxName: payload.paxName ?? current.paxName,
						destinations: payload.destinations ?? current.destinations,
						vatAmount: newVat,

						netPrice: newNet,
						sellPrice: newSell,
						profit: newSell - newNet,
						paidAmount: newPaid,
						paymentType: payload.paymentType || current.paymentType,
							paymentStatus: newPaid === newSell ? "PAID" : newPaid > 0 ? "PARTIAL" : "DUE",
						remarks: payload.remarks || null,
					},
				});

				totalNet += newNet;
				totalSell += newSell;
					totalProfit += (newSell - newNet);
			}

				/* ======================================================
					4.4 PERSIST ACCOUNT BALANCES
				====================================================== */
			for (const accId of touchedAccounts) {
				await tx.account.update({
					where: { id: accId },
					data: { balance: getBal(accId) },
				});
			}

				/* ======================================================
					4.5 UPDATE INVOICE TOTALS
				====================================================== */
			await tx.salesInvoice.update({
				where: { id: invoiceId },
				data: { totalNet, totalSell, totalProfit },
			});

			return { invoiceId, deletedSalesCount: deletedSales.length };
			},
			{ timeout: 20000, maxWait: 5000 }
		);

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



router.delete("/:invoiceId", authenticate, async (req, res) => {
	const { invoiceId } = req.params;
	
	try {
		await prisma.$transaction(async (tx) => {
			const invoice = await tx.salesInvoice.findUnique({
				where: { id: invoiceId },
				include: {
					sales: true,
				},
			});

			if (!invoice) throw new Error("Invoice not found");

			for (const sale of invoice.sales) {
				/* ---------------- Vendor Reversal ---------------- */
				const vendor = await tx.vendor.findUnique({
					where: { id: sale.vendorId },
					include: { account: true },
				});
				if (!vendor || !vendor.account) continue;

				const isDebitVendor = vendor.category === "DEBIT";
				const amount = sale.netPrice;

				const newVendorBalance = isDebitVendor
					? vendor.account.balance + amount
					: vendor.account.balance - amount;

				await tx.ledgerEntry.create({
					data: {
						accountId: vendor.account.id,
						entryType: "REFUNDED",
						debit: isDebitVendor ? amount : 0,
						credit: isDebitVendor ? 0 : amount,
						balanceAfter: newVendorBalance,
						saleId: sale.id,
						invoiceId,
						remarks: "Invoice deleted – vendor reversal",
					},
				});

				await tx.account.update({
					where: { id: vendor.account.id },
					data: { balance: newVendorBalance },
				});

				/* ---------------- Customer Reversal (CREDIT sale only) ---------------- */
				if (
					String(sale.paymentType).toUpperCase() === "CREDIT" &&
					sale.customerId
				) {
					const customer = await tx.customer.findUnique({
						where: { id: sale.customerId },
						include: { account: true },
					});

					if (!customer || !customer.account) continue;

					const newCustomerBalance = customer.account.balance - sale.sellPrice;

					await tx.ledgerEntry.create({
						data: {
							accountId: customer.account.id,
							entryType: "REFUNDED",
							debit: 0,
							credit: sale.sellPrice,
							balanceAfter: newCustomerBalance,
							saleId: sale.id,
							invoiceId,
							remarks: "Invoice deleted – customer reversal",
						},
					});

					await tx.account.update({
						where: { id: customer.account.id },
						data: { balance: newCustomerBalance },
					});
				}
			}

			/* ---------------- Delete Business Records ---------------- */
			await tx.sale.deleteMany({
				where: { invoiceId },
			});

			await tx.salesInvoice.delete({
				where: { id: invoiceId },
			});
		});

		res.json({
			success: true,
			message: "Sales invoice deleted successfully",
		});
	} catch (err) {
		console.error(err);
		res.status(400).json({
			success: false,
			error: err.message || "Failed to delete invoice",
		});
	}
});

export default router;
