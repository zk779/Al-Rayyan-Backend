import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { generateNextSalesInvoiceNo } from "../utils/invoiceNo.js";
import { localDayRangeToUtc } from "../utils/dateRange.js";

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
		const user = await prisma.user.findUnique({
			where: { id: decoded.id },
			include: {
				role: {
					include: { permissionLinks: { include: { permission: true } } },
				},
			},
		});
		if (!user || !user.isActive)
			return res.status(401).json({ error: "User inactive or removed" });

		req.user = {
			...decoded,
			permissions: user.role?.permissionLinks.map((link) => link.permission.name) || [],
		};
		next();
	} catch (err) {
		return res.status(401).json({ error: "Invalid or expired token" });
	}
}
router.get("/", authenticate, async (req, res) => {
	try {
		const { search, dateFrom, dateTo, order, createdById, branchId, tz, page = 1, limit = 20 } = req.query;

		const filters = [];

		// Search across invoiceNo (on the parent invoice) OR documentNo/remarks
		if (search) {
			filters.push({
				OR: [
					{ invoice: { invoiceNo: { contains: search, mode: "insensitive" } } },
					{ documentNo: { contains: search, mode: "insensitive" } },
					{ remarks: { contains: search, mode: "insensitive" } }
				]
			});
		}
		const permissions = req.user.permissions || [];

		if (permissions.includes("SALE_VIEW_ALL")) {
			if (createdById) filters.push({ invoice: { userId: createdById } });

			// Filter to a single branch when requested — otherwise no branch
			// restriction is applied and invoices from all branches are returned.
			if (branchId) filters.push({ invoice: { branchId } });
		} else if (permissions.includes("SALE_VIEW_BRANCH")) {
			filters.push({ invoice: { branchId: req.user.branchId || null } });
		} else {
			filters.push({ invoice: { userId: req.user.id } });
		}
		if (dateFrom || dateTo) {
			const saleDateFilter = {};
			const fromRange = localDayRangeToUtc(dateFrom, tz);
			if (fromRange) saleDateFilter.gte = fromRange.start;
			const toRange = localDayRangeToUtc(dateTo, tz);
			if (toRange) saleDateFilter.lte = toRange.end;
			if (Object.keys(saleDateFilter).length > 0) {
				filters.push({ invoice: { saleDate: saleDateFilter } });
			}
		}

		const where = filters.length > 0 ? { AND: filters } : {};
		const sortDirection = String(order || "").toLowerCase() === "asc" ? "asc" : "desc";
		const take = Math.min(Math.max(Number(limit) || 20, 1), 200);
		const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

		const [sales, total, summary] = await prisma.$transaction([
			prisma.sale.findMany({
				where,
				skip,
				take,
				orderBy: { invoice: { saleDate: sortDirection } },
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
					invoice: {
						select: {
							id: true,
							invoiceNo: true,
							saleDate: true,
							createdAt: true,
							user: { select: { id: true, fullName: true, email: true } },
							branch: { select: { id: true, name: true, code: true } }
						}
					},
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
					// Cash account (populated when paymentType = CASH)
					account: { select: { balance: true } },
					// Bank account (populated when paymentType = BANK_TRANSFER)
					bank: {
						select: {
							bankName: true,
							account: { select: { balance: true } }
						}
					},
					// Payment legs for PARTIAL sales — breakdown of how it was split
					payments: {
						select: {
							id: true,
							method: true,
							amount: true,
							remarks: true,
							paymentDate: true,
							bank: { select: { bankName: true } },
							customer: { select: { customerName: true } },
							account: { select: { balance: true } }
						}
					},
					// Refund created FROM this sale (original sale side)
					refunds: {
						select: {
							id: true,
							status: true,
							refundDate: true,
							netRefundToCustomer: true,
							vendorRefundAmount: true,
							refundFee: true,
							cancellationCharges: true,
							refundReason: true,
							remarks: true,
						}
					},
					// Refund that CREATED this sale (negative mirror sale side)
					refundRecord: {
						select: {
							id: true,
							status: true,
							refundDate: true,
							netRefundToCustomer: true,
							vendorRefundAmount: true,
							refundFee: true,
							cancellationCharges: true,
							refundReason: true,
							remarks: true,
						}
					}
				}
			}),
			prisma.sale.count({ where }),
			// Grand totals across the WHOLE filtered set, not just this page.
			prisma.sale.aggregate({ where, _sum: { netPrice: true, sellPrice: true, profit: true } })
		]);

		const data = sales.map(s => {
			const sellPrice = Number(s.sellPrice || 0);
			const paidAmount = Number(s.paidAmount || 0);
			const dueAmount = Math.max(sellPrice - paidAmount, 0);

			// Original sale (has its own refunds[0]) OR negative mirror
			// sale (has refundRecord instead) — whichever is present.
			const refundDetails =
				(s.refunds && s.refunds.length > 0 ? s.refunds[0] : null) ||
				s.refundRecord ||
				null;

			return {
				id: s.id,
				invoiceId: s.invoice?.id || null,
				invoiceNo: s.invoice?.invoiceNo || null,
				saleDate: s.invoice?.saleDate || null,
				createdAt: s.invoice?.createdAt || null,
				createdById: s.invoice?.user?.id || null,
				createdByName: s.invoice?.user?.fullName || null,
				createdByEmail: s.invoice?.user?.email || null,
				branchId: s.invoice?.branch?.id || null,
				branchName: s.invoice?.branch?.name || null,
				branchCode: s.invoice?.branch?.code || null,
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
				// Money breakdown
				sellPrice,
				paidAmount,
				dueAmount,
				customerId: s.customerId || null,
				customerName: s.customer?.customerName || null,
				customerPhone: s.customer?.phone || null,
				customerBalance: s.customer?.account?.balance ?? null,
				// Cash / bank account context (whichever applies)
				cashAccountBalance: s.account?.balance ?? null,
				bankName: s.bank?.bankName || null,
				bankAccountBalance: s.bank?.account?.balance ?? null,
				// Split payment breakdown, if PARTIAL
				paymentLegs: (s.payments || []).map(p => ({
					id: p.id,
					method: p.method,
					amount: p.amount,
					remarks: p.remarks,
					paymentDate: p.paymentDate,
					bankName: p.bank?.bankName || null,
					customerName: p.customer?.customerName || null,
					cashAccountBalance: p.account?.balance ?? null
				})),
				netPrice: s.netPrice,
				profit: s.profit,
				remarks: s.remarks,
				status: s.status,
				// Works for both the original sale (via refunds[]) and the
				// negative mirror sale (via refundRecord) — whichever applies.
				refund: refundDetails
			};
		});

		res.json({
			success: true,
			data,
			pagination: { page: Math.max(Number(page) || 1, 1), limit: take, total, pages: Math.max(Math.ceil(total / take), 1) },
			summary: {
				totalNet: summary._sum.netPrice || 0,
				totalSell: summary._sum.sellPrice || 0,
				totalProfit: summary._sum.profit || 0
			}
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to fetch sales invoices" });
	}
});

// GET /api/sales/:saleId/history
router.get("/:saleId/history", authenticate, async (req, res) => {
	const { saleId } = req.params;

	try {
		const sale = await prisma.sale.findUnique({
			where: { id: saleId },
			select: {
				id: true,
				documentNo: true,
				pnr: true,
				createdAt: true,
				updatedAt: true,
				updatedBy: true,
				invoice: {
					select: {
						invoiceNo: true,
						saleDate: true,
						user: {
							select: { id: true, fullName: true, email: true },
						},
					},
				},
			},
		});

		if (!sale) {
			return res.status(404).json({ success: false, error: "Sale not found" });
		}

		const editHistory = Array.isArray(sale.updatedBy) ? sale.updatedBy : [];

		const data = {
			saleId: sale.id,
			documentNo: sale.documentNo,
			pnr: sale.pnr,
			invoiceNo: sale.invoice?.invoiceNo || null,
			createdBy: {
				userId: sale.invoice?.user?.id || null,
				userName: sale.invoice?.user?.fullName || null,
				userEmail: sale.invoice?.user?.email || null,
				createdAt: sale.createdAt,
			},
			editCount: editHistory.length,
			edits: [...editHistory].sort(
				(a, b) => new Date(a.updatedAt) - new Date(b.updatedAt)
			), // most recent first
			lastEditedAt: sale.updatedAt,
		};

		res.status(200).json({ success: true, data });
	} catch (err) {
		console.error("Error fetching sale history:", err);
		res.status(500).json({ success: false, error: "Failed to fetch sale history" });
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


/* ======================= CHECK DUPLICATE DOCUMENT NO ======================= */
router.get("/check-document", authenticate, async (req, res) => {
	try {
		const { documentNo, excludeSaleId } = req.query;

		if (!documentNo || !documentNo.trim()) {
			return res.status(400).json({ success: false, error: "documentNo is required" });
		}

		const existing = await prisma.sale.findFirst({
			where: {
				documentNo: { equals: documentNo.trim(), mode: "insensitive" },
				...(excludeSaleId ? { id: { not: excludeSaleId } } : {}),
			},
			select: { id: true },
		});

		const exists = !!existing;

		res.json({
			success: true,
			exists,
			message: exists ? "Document already exists" : "Document does not exist",
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to check document number" });
	}
});


/* ======================= GET CUSTOMER SALES (DUE / PARTIAL) ======================= */
router.get("/customerSales", authenticate, async (req, res) => {
	try {
		const { customerId, paymentStatus } = req.query;

		if (!customerId) {
			return res.status(400).json({ success: false, error: "customerId is required" });
		}
		const statusList = paymentStatus
			? paymentStatus.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
			: ["DUE", "PARTIAL"];

		const sales = await prisma.sale.findMany({
			where: {
				customerId,
				paymentStatus: { in: statusList },
			},
			orderBy: { createdAt: "desc" },
			include: {
				invoice: {
					select: {
						id: true,
						invoiceNo: true,
						saleDate: true
					}
				},
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
				},
				bank: {
					select: {
						id: true,
						bankName: true,
						accountNumber: true,
						branchName: true
					}
				},
				payments: {
					select: {
						id: true,
						method: true,
						amount: true,
						paymentDate: true,
						remarks: true
					},
					orderBy: { paymentDate: "asc" }
				},
				refunds: {
					select: {
						id: true,
						netRefundToCustomer: true,
						refundDate: true,
					}
				}
			}
		});

		const data = sales
			.filter((s) => !s.refundRecordId)
			.map((s) => {
				const refund = s.refunds && s.refunds.length > 0 ? s.refunds[0] : null;

				const originalDueAmount = s.sellPrice - (s.paidAmount || 0);
				const netRefundToCustomer = refund ? Number(refund.netRefundToCustomer || 0) : 0;
				const dueAmount = originalDueAmount - netRefundToCustomer;

				return {
					id: s.id,
					invoiceId: s.invoice?.id || null,
					invoiceNo: s.invoice?.invoiceNo || null,
					saleDate: s.invoice?.saleDate || null,
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
					dueAmount,
					isRefunded: !!refund,
					refundedAmount: netRefundToCustomer,
					remarks: s.remarks,
					airlineCode: s.airline?.airlineCode || null,
					airlineName: s.airline?.airlineName || null,
					vendorName: s.vendor?.vendorName || null,
					vendorCategory: s.vendor?.category || null,
					vendorBalance: s.vendor?.account?.balance ?? null,
					customerName: s.customer?.customerName || null,
					customerPhone: s.customer?.phone || null,
					customerBalance: s.customer?.account?.balance ?? null,
					bank: s.bank
						? {
							id: s.bank.id,
							bankName: s.bank.bankName,
							accountNumber: s.bank.accountNumber,
							branchName: s.bank.branchName
						}
						: null,
					payments: s.payments,
					createdAt: s.createdAt
				};
			})
			.filter((s) => s.dueAmount > 0);

		res.json({ success: true, data });
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to fetch customer sales" });
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
				branch: {
					select: { id: true, name: true, code: true }
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
						refunds: {
							select: { id: true },
						},
					},
				},
			},
		});

		if (!invoice) {
			return res.status(404).json({ success: false, error: "Invoice not found" });
		}

		const activeSales = invoice.sales.filter(
			(sale) => !sale.refundRecordId && (!sale.refunds || sale.refunds.length === 0)
		);
		const enrichedSales = activeSales.map((sale) => {
			const { refunds, ...saleWithoutRefunds } = sale;
			const pt = String(sale.paymentType).toUpperCase();
			let paymentSummary;

			if (pt === "CASH") {
				paymentSummary = {
					type: "CASH",
					label: "Cash",
					amount: sale.paidAmount,
				};
			} else if (pt === "BANK_TRANSFER") {
				paymentSummary = {
					type: "BANK_TRANSFER",
					label: "Bank Transfer",
					amount: sale.paidAmount,
					bankId: sale.bank?.id || null,
					bankName: sale.bank?.bankName || null,
					accountNo: sale.bank?.accountNumber || null,
				};
			} else if (pt === "CREDIT") {
				paymentSummary = {
					type: "CREDIT",
					label: "Credit",
					amount: sale.sellPrice,
					paidAmount: sale.paidAmount,
					dueAmount: sale.sellPrice - sale.paidAmount,
					customerId: sale.customer?.id || null,
					customerName: sale.customer?.customerName || null,
				};
			} else if (pt === "PARTIAL") {
				const legs = (sale.payments || []).map((leg) => {
					const lm = String(leg.method).toUpperCase();
					return {
						id: leg.id,
						method: lm,
						amount: leg.amount,
						paymentDate: leg.paymentDate,
						remarks: leg.remarks || null,
						// bank fields — only populated for BANK_TRANSFER legs
						bankId: lm === "BANK_TRANSFER" ? (leg.bank?.id || null) : null,
						bankName: lm === "BANK_TRANSFER" ? (leg.bank?.bankName || null) : null,
						accountNo: lm === "BANK_TRANSFER" ? (leg.bank?.accountNumber || null) : null,
						// customer fields — only populated for CREDIT legs
						customerId: lm === "CREDIT" ? (leg.customer?.id || null) : null,
						customerName: lm === "CREDIT" ? (leg.customer?.customerName || null) : null,
					};
				});

				const comboKey = legs.map((l) => l.method).join("+");

				paymentSummary = {
					type: "PARTIAL",
					label: `Split (${legs.length} methods)`,
					combo: comboKey,
					legs,
					total: legs.reduce((s, l) => s + l.amount, 0),
				};
			} else {
				paymentSummary = { type: pt, label: pt, amount: sale.paidAmount };
			}

			return { ...saleWithoutRefunds, paymentSummary };
		});

		res.json({
			success: true,
			data: {
				...invoice,
				sales: enrichedSales,
				salesCount: enrichedSales.length,
				createdById: invoice.user?.id || null,
				createdByName: invoice.user?.fullName || null,
				createdByEmail: invoice.user?.email || null,
				branchId: invoice.branch?.id || null,
				branchName: invoice.branch?.name || null,
				branchCode: invoice.branch?.code || null,
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
				},
				refunds: {
					select: {
						id: true,
						netRefundToCustomer: true,
						refundDate: true,
					}
				}
			}
		});

		if (!sale) {
			return res.status(404).json({ success: false, error: "Sale not found" });
		}
		const refund = sale.refunds && sale.refunds.length > 0 ? sale.refunds[0] : null;

		const originalDueAmount = sale.sellPrice - (sale.paidAmount || 0);
		const netRefundToCustomer = refund ? Number(refund.netRefundToCustomer || 0) : 0;
		const dueAmount = originalDueAmount - netRefundToCustomer;

		res.json({
			success: true,
			data: {
				...sale,
				dueAmount,
				isRefunded: !!refund,
				refundedAmount: netRefundToCustomer,
			}
		});
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

			const pt = String(s.paymentType).toUpperCase();

			if (pt === "CREDIT" && !s.customerId)
				throw new Error("customerId required for CREDIT sales");

			if (pt === "BANK_TRANSFER" && !s.bankId)
				throw new Error("bankId required for BANK_TRANSFER sales");

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
		const businessDate = saleDate ? new Date(saleDate) : new Date();

		const result = await prisma.$transaction(async (tx) => {
			/* ── Invoice ── */
			const invoiceNo = await generateNextSalesInvoiceNo(tx, businessDate);

			const invoice = await tx.salesInvoice.create({
				data: {
					invoiceNo,
					saleDate: businessDate,
					userId: req.user.id,
					branchId: req.user.branchId || null,
				},
			});

			let cashAccount = null;
			const getCashAccount = async () => {
				if (cashAccount) return cashAccount;

				cashAccount = await tx.account.findFirst({
					where: { type: "CASH" },
				});

				if (!cashAccount) {
					cashAccount = await tx.account.create({
						data: {
							name: "Cash Account",
							type: "CASH",
							balance: 0,
						},
					});
				}

				return cashAccount;
			};
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
			const creditCash = async (amount, saleId, label) => {
				const cash = await getCashAccount();

				await tx.ledgerEntry.create({
					data: {
						accountId: cash.id,
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
					where: { id: cash.id },
					data: { balance: { increment: amount } },
				});
			};

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

			const processPartialWithCredit = async (s, sale, sell, creditLeg) => {
				const cust = customerMap[creditLeg.customerId];
				if (!cust) throw new Error(`Customer not found: ${creditLeg.customerId}`);

				// 1) Book the FULL sell price as a single SALE debit
				await tx.ledgerEntry.create({
					data: {
						accountId: cust.account.id,
						entryType: "SALE",
						debit: sell,
						credit: 0,
						transactionDate: businessDate,
						saleId: sale.id,
						invoiceId: invoice.id,
						remarks: `Partial sale (full invoice amount) - Invoice ${invoiceNo}`,
					},
				});

				let totalPaidNow = 0;

				for (const leg of s.paymentLegs) {
					const legMethod = String(leg.method).toUpperCase();
					const legAmount = Number(leg.amount);

					await tx.salePayment.create({
						data: {
							saleId: sale.id,
							method: legMethod,
							amount: legAmount,
							bankId: legMethod === "BANK_TRANSFER" ? (leg.bankId || null) : null,
							accountId: legMethod === "CASH" ? (await getCashAccount()).id : null,
							customerId: legMethod === "CREDIT" ? (leg.customerId || null) : null,
							remarks: leg.remarks || null,
							paymentDate: businessDate,
						},
					});

					if (legMethod === "CASH") {
						await creditCash(legAmount, sale.id, "Partial cash payment received");

						await tx.ledgerEntry.create({
							data: {
								accountId: cust.account.id,
								entryType: "PAYMENT",
								debit: 0,
								credit: legAmount,
								transactionDate: businessDate,
								saleId: sale.id,
								invoiceId: invoice.id,
								remarks: `Cash payment against credit sale - Invoice ${invoiceNo}`,
							},
						});

						totalPaidNow += legAmount;
					} else if (legMethod === "BANK_TRANSFER") {
						await creditBank(leg.bankId, legAmount, sale.id, "Partial bank transfer received");

						await tx.ledgerEntry.create({
							data: {
								accountId: cust.account.id,
								entryType: "PAYMENT",
								debit: 0,
								credit: legAmount,
								transactionDate: businessDate,
								saleId: sale.id,
								invoiceId: invoice.id,
								remarks: `Bank transfer payment against credit sale - Invoice ${invoiceNo}`,
							},
						});

						totalPaidNow += legAmount;
					}
				}
				await tx.account.update({
					where: { id: cust.account.id },
					data: { balance: { increment: sell - totalPaidNow } },
				});
			};

			/* ── Process each sale ── */
			for (const s of sales) {
				const vendor = vendorMap[s.vendorId];
				const net = Number(s.netPrice);
				const sell = Number(s.sellPrice);
				const paid = Number(s.paidAmount || 0);
				const vatAmt = Number(s.vatAmount || 0);
				const profit = sell - net - vatAmt;
				const pt = String(s.paymentType).toUpperCase();
				const partialCreditLeg = pt === "PARTIAL"
					? s.paymentLegs.find(l => String(l.method).toUpperCase() === "CREDIT")
					: null;
				const saleCustomerId = pt === "PARTIAL"
					? (partialCreditLeg?.customerId || null)
					: (s.customerId || null);

				/* ── Create sale record ── */
				const sale = await tx.sale.create({
					data: {
						invoiceId: invoice.id,
						airlineId: s.airlineId,
						vendorId: s.vendorId,
						customerId: saleCustomerId,
						bankId: pt === "BANK_TRANSFER" ? (s.bankId || null) : null,
						accountId: pt === "CASH" ? (await getCashAccount()).id : null,
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
					await creditCash(paid, sale.id, "Cash payment received");
				} else if (pt === "BANK_TRANSFER") {
					await creditBank(s.bankId, paid, sale.id, "Bank transfer payment received");

					const remainingBT = sell - paid;
					if (remainingBT > 0 && s.customerId) {
						await creditCustomer(s.customerId, remainingBT, 0, sale.id, "Balance due after bank transfer");
					}
				} else if (pt === "CREDIT") {
					await creditCustomer(s.customerId, sell, paid, sale.id, "Sale on credit");
				} else if (pt === "PARTIAL") {
					const creditLeg = partialCreditLeg;

					if (creditLeg) {
						await processPartialWithCredit(s, sale, sell, creditLeg);
					} else {
						for (const leg of s.paymentLegs) {
							const legMethod = String(leg.method).toUpperCase();
							const legAmount = Number(leg.amount);

							await tx.salePayment.create({
								data: {
									saleId: sale.id,
									method: legMethod,
									amount: legAmount,
									bankId: legMethod === "BANK_TRANSFER" ? (leg.bankId || null) : null,
									accountId: legMethod === "CASH" ? (await getCashAccount()).id : null,
									customerId: null,
									remarks: leg.remarks || null,
									paymentDate: businessDate,
								},
							});

							if (legMethod === "CASH") {
								await creditCash(legAmount, sale.id, "Partial cash payment received");
							} else if (legMethod === "BANK_TRANSFER") {
								await creditBank(
									leg.bankId,
									legAmount,
									sale.id,
									"Partial bank transfer received"
								);
							}
						}
					}
				}

			}
			const totals = await tx.sale.aggregate({
				where: { invoiceId: invoice.id },
				_sum: { netPrice: true, sellPrice: true, profit: true },
			});

			await tx.salesInvoice.update({
				where: { id: invoice.id },
				data: {
					totalNet: totals._sum.netPrice || 0,
					totalSell: totals._sum.sellPrice || 0,
					totalProfit: totals._sum.profit || 0,
				},
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
						// Minimal selection just to detect whether this sale has
						// already been refunded (see editableSales filter below).
						refunds: {
							select: { id: true },
						},
					},
				},
			},
		});

		if (!existingInvoice) {
			return res.status(404).json({ success: false, error: "Invoice not found" });
		}
		const editableSales = existingInvoice.sales.filter(
			(s) => !s.refundRecordId && (!s.refunds || s.refunds.length === 0)
		);

		const saleMap = new Map(editableSales.map(s => [s.id, s]));

		for (const s of sales) {
			if (!s.id) throw new Error("Each sale must include 'id'");
			if (!saleMap.has(s.id)) {
				throw new Error(
					`Sale not found or not editable (it may already be refunded): ${s.id}`
				);
			}
		}
		const payloadSaleIds = new Set(sales.map(s => s.id));
		const deletedSales = editableSales.filter(s => !payloadSaleIds.has(s.id));

		/* ======================================================
		   3️⃣  PRE-LOAD ALL VENDORS / CUSTOMERS / BANKS / CASH
		====================================================== */
		const vendorIdSet = new Set();
		const customerIdSet = new Set();
		const bankIdSet = new Set();
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

		const [vendors, customers, banks, existingCashAccount] = await Promise.all([
			vendorIdSet.size
				? prisma.vendor.findMany({ where: { id: { in: [...vendorIdSet] } }, include: { account: true } })
				: [],
			customerIdSet.size
				? prisma.customer.findMany({ where: { id: { in: [...customerIdSet] } }, include: { account: true } })
				: [],
			bankIdSet.size
				? prisma.bank.findMany({ where: { id: { in: [...bankIdSet] } }, include: { account: true } })
				: [],
			prisma.account.findFirst({ where: { type: "CASH" } }),
		]);

		const vendorMap = new Map(vendors.map(v => [v.id, v]));
		const customerMap = new Map(customers.map(c => [c.id, c]));
		const bankMap = new Map(banks.map(b => [b.id, b]));

		const businessDate = saleDate ? new Date(saleDate) : new Date();
		const dateChanged =
			new Date(existingInvoice.saleDate).getTime() !== businessDate.getTime();

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

			// Seed cash account (if it already exists)
			let cashAccount = existingCashAccount;
			if (cashAccount) seedBalance(cashAccount);

			const getBal = (id) => balances.get(id) || 0;
			const setBal = (id, v) => { balances.set(id, Number(v)); touchedAccounts.add(id); };
			const adjBal = (id, d) => setBal(id, getBal(id) + d);

			const getCashAccount = async () => {
				if (cashAccount) return cashAccount;

				cashAccount = await tx.account.create({
					data: { name: "Cash Account", type: "CASH", balance: 0 },
				});
				balances.set(cashAccount.id, 0);

				return cashAccount;
			};
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

			/** Apply a cash-received-payment ledger entry (money in) */
			const applyCashPayment = async (amount, saleId) => {
				const cash = await getCashAccount();
				await tx.ledgerEntry.create({
					data: {
						accountId: cash.id, entryType: "PAYMENT",
						debit: 0, credit: amount,
						transactionDate: businessDate,
						saleId, invoiceId,
						remarks: `Cash payment received - Invoice ${invoiceNo}`,
					},
				});
				adjBal(cash.id, amount);
			};

			/** Reverse a previous cash-received-payment (money out) */
			const reverseCashPayment = async (amount, saleId) => {
				if (!cashAccount) return;
				await tx.ledgerEntry.deleteMany({
					where: { saleId, accountId: cashAccount.id, entryType: "PAYMENT" },
				});
				adjBal(cashAccount.id, -amount);
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

				if (paidNow > 0) {
					await tx.ledgerEntry.create({
						data: {
							accountId: cust.account.id, entryType: "PAYMENT",
							debit: 0, credit: paidNow,
							transactionDate: businessDate,
							saleId, invoiceId,
							remarks: `Payment received - Invoice ${invoiceNo}`,
						},
					});
				}

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
			const applyPartialWithCredit = async (payload, saleId, creditLeg) => {
				const cust = customerMap.get(creditLeg.customerId);
				if (!cust) throw new Error(`Customer not found: ${creditLeg.customerId}`);

				const sell = Number(payload.sellPrice);

				// 1) Book the FULL sell price as a single SALE debit
				await tx.ledgerEntry.create({
					data: {
						accountId: cust.account.id,
						entryType: "SALE",
						debit: sell,
						credit: 0,
						transactionDate: businessDate,
						saleId, invoiceId,
						remarks: `Partial sale (full invoice amount) - Invoice ${invoiceNo}`,
					},
				});

				let totalPaidNow = 0;

				for (const leg of payload.paymentLegs) {
					const lm = String(leg.method).toUpperCase();
					const legAmount = Number(leg.amount);

					await tx.salePayment.create({
						data: {
							saleId,
							method: lm,
							amount: legAmount,
							bankId: lm === "BANK_TRANSFER" ? (leg.bankId || null) : null,
							accountId: lm === "CASH" ? (await getCashAccount()).id : null,
							customerId: lm === "CREDIT" ? (leg.customerId || null) : null,
							remarks: leg.remarks || null,
							paymentDate: businessDate,
						},
					});

					if (lm === "CASH") {
						await applyCashPayment(legAmount, saleId);

						await tx.ledgerEntry.create({
							data: {
								accountId: cust.account.id,
								entryType: "PAYMENT",
								debit: 0,
								credit: legAmount,
								transactionDate: businessDate,
								saleId, invoiceId,
								remarks: `Cash payment against credit sale - Invoice ${invoiceNo}`,
							},
						});

						totalPaidNow += legAmount;
					} else if (lm === "BANK_TRANSFER") {
						await applyBankPayment(leg.bankId, legAmount, saleId);

						await tx.ledgerEntry.create({
							data: {
								accountId: cust.account.id,
								entryType: "PAYMENT",
								debit: 0,
								credit: legAmount,
								transactionDate: businessDate,
								saleId, invoiceId,
								remarks: `Bank transfer payment against credit sale - Invoice ${invoiceNo}`,
							},
						});

						totalPaidNow += legAmount;
					}
				}

				adjBal(cust.account.id, sell - totalPaidNow);
			};
			const reversePartialWithCredit = async (sale, creditLeg) => {
				const cust = customerMap.get(creditLeg.customerId);
				if (!cust) return;
				await tx.ledgerEntry.deleteMany({
					where: { saleId: sale.id, accountId: cust.account.id, entryType: { in: ["SALE", "PAYMENT"] } },
				});

				let oldTotalPaidNow = 0;

				for (const leg of (sale.payments || [])) {
					const lm = String(leg.method).toUpperCase();
					const legAmount = Number(leg.amount);

					if (lm === "CASH") {
						await reverseCashPayment(legAmount, sale.id);
						oldTotalPaidNow += legAmount;
					} else if (lm === "BANK_TRANSFER" && leg.bankId) {
						await reverseBankPayment(leg.bankId, legAmount, sale.id);
						oldTotalPaidNow += legAmount;
					}
				}

				const oldSell = Number(sale.sellPrice);
				adjBal(cust.account.id, -(oldSell - oldTotalPaidNow));
			};

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
				if (pt === "CASH") {
					await reverseCashPayment(paid, sale.id);
				}

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
					const creditLeg = (sale.payments || []).find(
						l => String(l.method).toUpperCase() === "CREDIT"
					);

					if (creditLeg) {
						await reversePartialWithCredit(sale, creditLeg);
					} else {
						for (const leg of (sale.payments || [])) {
							const lm = String(leg.method).toUpperCase();
							if (lm === "CASH") {
								await reverseCashPayment(leg.amount, sale.id);
							}
							if (lm === "BANK_TRANSFER" && leg.bank?.account) {
								await reverseBankPayment(leg.bankId, leg.amount, sale.id);
							}
						}
					}
					await tx.salePayment.deleteMany({ where: { saleId: sale.id } });
				}

				await tx.sale.delete({ where: { id: sale.id } });
			}

			/* ══════════════════════════════════════════════════════
			   4.2  UPDATE EACH SALE IN PAYLOAD
			══════════════════════════════════════════════════════ */

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

				} else if (dateChanged) {
					const vendor = vendorMap.get(current.vendorId);
					if (vendor?.account) {
						await tx.ledgerEntry.updateMany({
							where: { saleId: current.id, accountId: vendor.account.id, entryType: "SALE" },
							data: { transactionDate: businessDate },
						});
					}
				}
				const paymentSideChanged =
					paymentTypeChanged || sellChanged || paidChanged || customerChanged || bankChanged ||
					(newPt === "PARTIAL"); // always re-sync partial legs

				if (paymentSideChanged) {
					/* ── REVERSE OLD payment side ── */
					if (oldPt === "CASH") {
						await reverseCashPayment(oldPaid, current.id);
					}

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
						const oldCreditLeg = (current.payments || []).find(
							l => String(l.method).toUpperCase() === "CREDIT"
						);

						if (oldCreditLeg) {
							await reversePartialWithCredit(current, oldCreditLeg);
						} else {
							for (const leg of (current.payments || [])) {
								const lm = String(leg.method).toUpperCase();
								if (lm === "CASH") {
									await reverseCashPayment(leg.amount, current.id);
								}
								if (lm === "BANK_TRANSFER" && leg.bankId) {
									await reverseBankPayment(leg.bankId, leg.amount, current.id);
								}
							}
						}
						// Delete all old SalePayment legs
						await tx.salePayment.deleteMany({ where: { saleId: current.id } });
					}

					/* ── APPLY NEW payment side ── */
					if (newPt === "CASH") {
						await applyCashPayment(newPaid, current.id);
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
						const newCreditLeg = payload.paymentLegs.find(
							l => String(l.method).toUpperCase() === "CREDIT"
						);

						if (newCreditLeg) {
							await applyPartialWithCredit(payload, current.id, newCreditLeg);
						} else {
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
										accountId: lm === "CASH" ? (await getCashAccount()).id : null,
										customerId: null,
										remarks: leg.remarks || null,
										paymentDate: businessDate,
									},
								});

								if (lm === "CASH") {
									await applyCashPayment(legAmount, current.id);
								}

								if (lm === "BANK_TRANSFER") {
									await applyBankPayment(leg.bankId, legAmount, current.id);
								}
							}
						}
					}
				} else if (dateChanged) {
					await tx.ledgerEntry.updateMany({
						where: { saleId: current.id },
						data: { transactionDate: businessDate },
					});
					await tx.salePayment.updateMany({
						where: { saleId: current.id },
						data: { paymentDate: businessDate },
					});
				}

				/* ── Track who edited this sale ── */
				const updatedByHistory = Array.isArray(current.updatedBy) ? current.updatedBy : [];
				const newUpdatedBy = [
					...updatedByHistory,
					{
						userId: req.user.id,
						userName: req.user.fullName || null,
						userEmail: req.user.email || null,
						updatedAt: new Date().toISOString(),
					},
				];
				const saleCustomerId = newPt === "PARTIAL"
					? (payload.paymentLegs.find(l => String(l.method).toUpperCase() === "CREDIT")?.customerId || null)
					: ((newPt === "CREDIT" || newPt === "BANK_TRANSFER") ? (payload.customerId || null) : null);

				/* ── UPDATE SALE RECORD ── */
				await tx.sale.update({
					where: { id: current.id },
					data: {
						airlineId: payload.airlineId,
						vendorId: payload.vendorId,
						customerId: saleCustomerId,
						bankId: newPt === "BANK_TRANSFER" ? (payload.bankId || null) : null,
						accountId: newPt === "CASH" ? (await getCashAccount()).id : null,
						documentNo: payload.documentNo || null,
						pnr: payload.pnr ?? current.pnr,
						routeType: payload.routeType ?? current.routeType,
						tripType: payload.tripType ?? current.tripType,
						departureDate: payload.departureDate ? new Date(payload.departureDate) : current.departureDate,
						returnDate: payload.returnDate ? new Date(payload.returnDate) : current.returnDate,
						paxName: payload.paxName === undefined ? current.paxName : payload.paxName,
						destinations: payload.destinations ?? current.destinations,
						netPrice: newNet,
						sellPrice: newSell,
						profit: newSell - newNet - Number(payload.vatAmount || 0),
						vatAmount: Number(payload.vatAmount || 0),
						paxVat: Number(payload.paxVat || 0),
						miscCharges: Number(payload.miscCharges || 0),
						paidAmount: newPaid,
						paymentType: newPt,
						paymentStatus: newPaid >= newSell ? "PAID" : newPaid > 0 ? "PARTIAL" : "DUE",
						remarks: payload.remarks || null,
						updatedBy: newUpdatedBy,
					},
				});

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
			const totals = await tx.sale.aggregate({
				where: { invoiceId },
				_sum: { netPrice: true, sellPrice: true, profit: true },
			});

			await tx.salesInvoice.update({
				where: { id: invoiceId },
				data: {
					totalNet: totals._sum.netPrice || 0,
					totalSell: totals._sum.sellPrice || 0,
					totalProfit: totals._sum.profit || 0,
				},
			});

			return { invoiceId, deletedSalesCount: deletedSales.length, dateChanged };

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
			/* 1️⃣ Load invoice with sales + all payment-side relations */
			const invoice = await tx.salesInvoice.findUnique({
				where: { id: invoiceId },
				include: {
					sales: {
						include: {
							vendor: { include: { account: true } },
							customer: { include: { account: true } },
							bank: { include: { account: true } },
							account: true, // cash account (populated when paymentType/leg = CASH)
							payments: {
								include: {
									bank: { include: { account: true } },
									customer: { include: { account: true } },
									account: true, // cash account for PARTIAL cash legs
								},
							},
						},
					},
				},
			});

			if (!invoice) throw new Error("Invoice not found");

			/* 2️⃣ Reverse each sale */
			for (const sale of invoice.sales) {
				const net = Number(sale.netPrice || 0);
				const sell = Number(sale.sellPrice || 0);
				const paid = Number(sale.paidAmount || 0);
				const pt = String(sale.paymentType || "").toUpperCase();

				/* ──────────────────────────────────────────────────
				   VENDOR REVERSAL
				────────────────────────────────────────────────── */
				if (sale.vendor?.account) {
					const vendor = sale.vendor;
					const accId = vendor.account.id;
					const isDebit = vendor.category === "DEBIT";

					const delta = isDebit ? -net : net; // Opposite of original

					await tx.ledgerEntry.deleteMany({
						where: {
							saleId: sale.id,
							accountId: accId,
							entryType: "SALE",
						},
					});

					await tx.account.update({
						where: { id: accId },
						data: { balance: { increment: delta } },
					});
				}

				/* ──────────────────────────────────────────────────
				   PAYMENT-SIDE REVERSAL
				────────────────────────────────────────────────── */
				if (pt === "CASH") {
					if (sale.account) {
						await tx.ledgerEntry.deleteMany({
							where: {
								saleId: sale.id,
								accountId: sale.account.id,
								entryType: "PAYMENT",
							},
						});

						await tx.account.update({
							where: { id: sale.account.id },
							data: { balance: { decrement: paid } },
						});
					}
				}

				else if (pt === "BANK_TRANSFER") {
					if (sale.bank?.account) {
						await tx.ledgerEntry.deleteMany({
							where: {
								saleId: sale.id,
								accountId: sale.bank.account.id,
								entryType: "PAYMENT",
							},
						});

						await tx.account.update({
							where: { id: sale.bank.account.id },
							data: { balance: { decrement: paid } },
						});
					}

					const remainingBT = sell - paid;
					if (remainingBT > 0 && sale.customer?.account) {
						const accId = sale.customer.account.id;

						await tx.ledgerEntry.deleteMany({
							where: {
								saleId: sale.id,
								accountId: accId,
								entryType: { in: ["SALE", "PAYMENT"] },
							},
						});

						await tx.account.update({
							where: { id: accId },
							data: { balance: { decrement: remainingBT } },
						});
					}
				}

				else if (pt === "CREDIT") {
					if (sale.customer?.account) {
						const accId = sale.customer.account.id;

						await tx.ledgerEntry.deleteMany({
							where: {
								saleId: sale.id,
								accountId: accId,
								entryType: { in: ["SALE", "PAYMENT"] },
							},
						});

						const balanceDelta = -(sell - paid); // Remove receivable created at sale time
						await tx.account.update({
							where: { id: accId },
							data: { balance: { increment: balanceDelta } },
						});
					}
				}

				else if (pt === "PARTIAL") {
					for (const leg of sale.payments || []) {
						const lm = String(leg.method || "").toUpperCase();
						const legAmount = Number(leg.amount || 0);

						if (lm === "CASH" && leg.account) {
							await tx.ledgerEntry.deleteMany({
								where: {
									saleId: sale.id,
									accountId: leg.account.id,
									entryType: "PAYMENT",
								},
							});

							await tx.account.update({
								where: { id: leg.account.id },
								data: { balance: { decrement: legAmount } },
							});
						}

						else if (lm === "BANK_TRANSFER" && leg.bank?.account) {
							await tx.ledgerEntry.deleteMany({
								where: {
									saleId: sale.id,
									accountId: leg.bank.account.id,
									entryType: "PAYMENT",
								},
							});

							await tx.account.update({
								where: { id: leg.bank.account.id },
								data: { balance: { decrement: legAmount } },
							});
						}

						else if (lm === "CREDIT" && leg.customer?.account) {
							await tx.ledgerEntry.deleteMany({
								where: {
									saleId: sale.id,
									accountId: leg.customer.account.id,
									entryType: { in: ["SALE", "PAYMENT"] },
								},
							});

							await tx.account.update({
								where: { id: leg.customer.account.id },
								data: { balance: { decrement: legAmount } },
							});
						}
					}

					await tx.salePayment.deleteMany({ where: { saleId: sale.id } });
				}
			}

			/* 3️⃣ Safety cleanup — delete all remaining ledger entries for this invoice */
			await tx.ledgerEntry.deleteMany({
				where: { invoiceId },
			});

			/* 4️⃣ Delete sales */
			await tx.sale.deleteMany({
				where: { invoiceId },
			});

			/* 5️⃣ Delete invoice */
			await tx.salesInvoice.delete({
				where: { id: invoiceId },
			});
		}, { timeout: 30000 });

		res.json({
			success: true,
			message: "Invoice deleted successfully",
		});
	} catch (err) {
		console.error(err);
		res.status(400).json({
			success: false,
			error: err.message || "Failed to delete invoice",
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
					account: true, // cash account
					payments: {
						include: {
							bank: { include: { account: true } },
							customer: { include: { account: true } },
							account: true, // cash account for PARTIAL cash legs
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
			if (pt === "CASH") {
				/* Cash received full paid amount in create/update API */
				if (sale.account) {
					await tx.ledgerEntry.deleteMany({
						where: {
							saleId: sale.id,
							accountId: sale.account.id,
							entryType: "PAYMENT",
						},
					});

					await tx.account.update({
						where: { id: sale.account.id },
						data: { balance: { decrement: paid } },
					});
				}
			}

			else if (pt === "BANK_TRANSFER") {
				/* Bank received paid amount in create API */
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
						balance: { decrement: paid },
					},
				});

				/* If there was a remaining balance charged to customer */
				const remainingBT = sell - paid;
				if (remainingBT > 0 && sale.customer?.account) {
					const accId = sale.customer.account.id;

					await tx.ledgerEntry.deleteMany({
						where: {
							saleId: sale.id,
							accountId: accId,
							entryType: { in: ["SALE", "PAYMENT"] },
						},
					});

					await tx.account.update({
						where: { id: accId },
						data: { balance: { decrement: remainingBT } },
					});
				}
			}

			else if (pt === "CREDIT") {
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
				const creditLeg = sale.payments.find(
					l => String(l.method || "").toUpperCase() === "CREDIT"
				);

				if (creditLeg) {
					if (!creditLeg.customer?.account) {
						throw new Error(`Related customer account not found for payment leg ${creditLeg.id}`);
					}

					const custAccId = creditLeg.customer.account.id;

					// Delete the consolidated SALE debit + PAYMENT credits
					// booked on the customer's ledger for this sale.
					await tx.ledgerEntry.deleteMany({
						where: {
							saleId: sale.id,
							accountId: custAccId,
							entryType: { in: ["SALE", "PAYMENT"] },
						},
					});

					let totalPaidNow = 0;

					for (const leg of sale.payments) {
						const legMethod = String(leg.method || "").toUpperCase();
						const legAmount = Number(leg.amount || 0);

						if (legMethod === "CASH") {
							if (!leg.account) {
								throw new Error(`Related cash account not found for payment leg ${leg.id}`);
							}

							await tx.ledgerEntry.deleteMany({
								where: {
									saleId: sale.id,
									accountId: leg.account.id,
									entryType: "PAYMENT",
								},
							});

							await tx.account.update({
								where: { id: leg.account.id },
								data: { balance: { decrement: legAmount } },
							});

							totalPaidNow += legAmount;
						} else if (legMethod === "BANK_TRANSFER") {
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
								data: { balance: { decrement: legAmount } },
							});

							totalPaidNow += legAmount;
						}
					}
					await tx.account.update({
						where: { id: custAccId },
						data: { balance: { decrement: sell - totalPaidNow } },
					});

				} else {
					for (const leg of sale.payments) {
						const legMethod = String(leg.method || "").toUpperCase();
						const legAmount = Number(leg.amount || 0);

						if (legMethod === "CASH") {
							if (!leg.account) {
								throw new Error(`Related cash account not found for payment leg ${leg.id}`);
							}

							await tx.ledgerEntry.deleteMany({
								where: {
									saleId: sale.id,
									accountId: leg.account.id,
									entryType: "PAYMENT",
								},
							});

							await tx.account.update({
								where: { id: leg.account.id },
								data: { balance: { decrement: legAmount } },
							});
						} else if (legMethod === "BANK_TRANSFER") {
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
								data: { balance: { decrement: legAmount } },
							});
						}
					}
				}

				/* Delete payment legs after reversal */
				await tx.salePayment.deleteMany({
					where: { saleId: sale.id },
				});
			}

			await tx.ledgerEntry.deleteMany({
				where: { saleId: sale.id },
			});

			/* ══════════════════════════════════════════════════════
			   STEP 4 — DELETE SALE
			══════════════════════════════════════════════════════ */
			await tx.sale.delete({
				where: { id: sale.id },
			});
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
