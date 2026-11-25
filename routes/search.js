import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

// The header search. ONE light request for the whole box instead of one heavy list per screen:
//   GET /api/search?q=&scope=&field=&limit=
//     scope: all | sales | customers | vendors | other | expenses | payments   (default all)
//     field: inv | doc | pnr | pax   (sales only — narrows what the text is matched against)
// A group is only searched when the caller may read it (SALE_READ, CUSTOMER_READ, VENDOR_READ,
// EXPENSE_READ, PAYMENT_READ, OTHER_SERVICE_READ). Sales / other services follow the same visibility
// rule as their lists (everything / own branch / own); hotel bookings and void sales are only included
// with HOTEL_READ / VOID_READ (insurance policies with INSURANCE_READ). A number also matches amounts.

const router = express.Router();
const prisma = new PrismaClient();

async function authenticate(req, res, next) {
	const authHeader = req.headers.authorization;
	if (!authHeader) return res.status(401).json({ success: false, error: "Missing Authorization header" });
	const token = authHeader.split(" ")[1];
	try {
		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		const user = await prisma.user.findUnique({
			where: { id: decoded.id },
			include: { role: { include: { permissionLinks: { include: { permission: true } } } } },
		});
		if (!user || !user.isActive) return res.status(401).json({ success: false, error: "User inactive or removed" });
		req.user = {
			...decoded,
			branchId: user.branchId || null,
			permissions: user.role?.permissionLinks.map((l) => l.permission.name) || [],
		};
		next();
	} catch {
		return res.status(401).json({ success: false, error: "Invalid or expired token" });
	}
}

const CATEGORY_LABELS = {
	OFFICE_SUPPLIES: "Office Supplies",
	SALARY: "Salary",
	TRAVEL: "Travel",
	MARKETING: "Marketing",
	MEALS: "Meals",
	TRAINING: "Training",
	RETURNABLE_VAT: "Returnable VAT",
	UTILITIES: "Utilities",
	RENT: "Rent",
	INSURANCE: "Insurance",
	MAINTENANCE: "Maintenance",
	COMPANY_EXPENSE: "Company Expense",
	OTHER: "Other",
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

router.get("/", authenticate, async (req, res) => {
	try {
		const q = String(req.query.q || "").trim().slice(0, 80);
		if (q.length < 2) return res.json({ success: true, q, data: {} });

		const scope = String(req.query.scope || "all").toLowerCase();
		const field = String(req.query.field || "").toLowerCase();
		const limit = scope === "all" ? 5 : 12;
		const perms = req.user.permissions;
		const has = (p) => perms.includes(p);
		const wants = (name) => scope === "all" || scope === name;
		const contains = { contains: q, mode: "insensitive" };
		// a number also matches the amount (to the halala)
		const num = /^\d{1,12}(\.\d{1,2})?$/.test(q) ? Number(q) : null;
		const near = num === null ? null : { gte: round2(num - 0.005), lte: round2(num + 0.005) };

		// the same visibility rule as the lists
		const seeAll = has("SALE_VIEW_ALL");
		const seeBranch = !seeAll && has("SALE_VIEW_BRANCH");
		const invoiceScope = seeAll ? null : seeBranch ? { invoice: { branchId: req.user.branchId } } : { invoice: { userId: req.user.id } };
		const osScope = seeAll ? null : seeBranch ? { branchId: req.user.branchId } : { userId: req.user.id };

		const jobs = {};

		if (wants("sales") && has("SALE_READ")) {
			jobs.sales = (async () => {
				const textFields = {
					inv: [{ invoice: { invoiceNo: contains } }],
					doc: [{ documentNo: contains }],
					pnr: [{ pnr: contains }],
					pax: [{ paxName: contains }],
				};
				const or = textFields[field] || [
					{ invoice: { invoiceNo: contains } },
					{ documentNo: contains },
					{ pnr: contains },
					{ paxName: contains },
					{ hotelName: contains },
				];
				if (near && !field) or.push({ sellPrice: near });
				const AND = [{ OR: or }];
				if (invoiceScope) AND.push(invoiceScope);
				if (!has("HOTEL_READ")) AND.push({ OR: [{ saleType: { not: "HOTEL" } }, { saleType: null }, { saleType: { isSet: false } }] });
				if (!has("INSURANCE_READ")) AND.push({ OR: [{ saleType: { not: "INSURANCE" } }, { saleType: null }, { saleType: { isSet: false } }] });
				if (!has("VOID_READ")) AND.push({ status: { not: "VOID" } });
				const rows = await prisma.sale.findMany({
					where: { AND },
					orderBy: { createdAt: "desc" },
					take: limit,
					select: {
						id: true,
						invoiceId: true,
						documentNo: true,
						saleType: true,
						status: true,
						pnr: true,
						paxName: true,
						hotelName: true,
						sellPrice: true,
						paymentStatus: true,
						invoice: { select: { invoiceNo: true, saleDate: true } },
						airline: { select: { airlineCode: true, iataName: true } },
						vendor: { select: { vendorName: true } },
						customer: { select: { customerName: true } },
					},
				});
				return rows.map((s) => ({
					id: s.id,
					invoiceId: s.invoiceId,
					invoiceNo: s.invoice?.invoiceNo || null,
					documentNo: s.documentNo,
					saleType: s.saleType || "AIRLINE",
					status: s.status,
					pnr: s.pnr,
					paxName: s.paxName,
					hotelName: s.hotelName,
					sellPrice: s.sellPrice,
					airline: s.airline?.iataName || s.airline?.airlineCode || null,
					vendorName: s.vendor?.vendorName || null,
					customerName: s.customer?.customerName || null,
					amountMatch: !!near && s.sellPrice >= near.gte && s.sellPrice <= near.lte,
				}));
			})();
		}

		if (wants("customers") && has("CUSTOMER_READ")) {
			jobs.customers = prisma.customer
				.findMany({
					where: { OR: [{ customerName: contains }, { contactPerson: contains }, { phone: contains }, { customerVatId: contains }] },
					orderBy: { customerName: "asc" },
					take: limit,
					select: { id: true, customerName: true, customerType: true, contactPerson: true, phone: true, customerVatId: true, account: { select: { balance: true } } },
				})
				.then((rows) => rows.map((c) => ({ id: c.id, name: c.customerName, type: c.customerType, contact: c.contactPerson, phone: c.phone, vatId: c.customerVatId, balance: c.account?.balance ?? 0 })));
		}

		if (wants("vendors") && has("VENDOR_READ")) {
			jobs.vendors = prisma.vendor
				.findMany({
					where: { OR: [{ vendorName: contains }, { phone: contains }, { email: contains }] },
					orderBy: { vendorName: "asc" },
					take: limit,
					select: { id: true, vendorName: true, category: true, phone: true, account: { select: { balance: true } } },
				})
				.then((rows) => rows.map((v) => ({ id: v.id, name: v.vendorName, category: v.category, phone: v.phone, balance: v.account?.balance ?? 0 })));
		}

		if (wants("other") && has("OTHER_SERVICE_READ")) {
			jobs.other = (async () => {
				const or = [{ invoiceNo: contains }, { customerName: contains }, { referenceNo: contains }, { customerPhone: contains }, { customerCrNo: contains }];
				if (near) or.push({ total: near });
				const AND = [{ OR: or }];
				if (osScope) AND.push(osScope);
				const rows = await prisma.otherServiceInvoice.findMany({
					where: { AND },
					orderBy: { invoiceDate: "desc" },
					take: limit,
					select: { id: true, invoiceNo: true, customerName: true, serviceType: true, total: true, status: true },
				});
				return rows.map((o) => ({ ...o, amountMatch: !!near && o.total >= near.gte && o.total <= near.lte }));
			})();
		}

		if (wants("expenses") && has("EXPENSE_READ")) {
			jobs.expenses = (async () => {
				const ql = q.toLowerCase();
				const cats = Object.entries(CATEGORY_LABELS).filter(([k, l]) => l.toLowerCase().includes(ql) || k.toLowerCase().includes(ql)).map(([k]) => k);
				const or = [
					{ description: contains },
					{ branch: { name: contains } },
					{ user: { fullName: contains } },
					{ details: { some: { value: contains } } },
					...(cats.length ? [{ category: { in: cats } }] : []),
				];
				if (near) or.push({ amount: near });
				const rows = await prisma.expense.findMany({
					where: { OR: or },
					orderBy: { expenseDate: "desc" },
					take: limit,
					select: { id: true, expenseDate: true, category: true, amount: true, vatAmount: true, description: true, status: true, details: true, branch: { select: { name: true } } },
				});
				return rows.map((e) => ({
					id: e.id,
					expenseDate: e.expenseDate,
					category: e.category,
					categoryLabel: CATEGORY_LABELS[e.category] || e.category,
					amount: e.amount,
					vatAmount: e.vatAmount,
					description: e.description,
					status: e.status,
					branchName: e.branch?.name || null,
					firstDetail: e.details?.[0] ? `${e.details[0].label}: ${e.details[0].value}` : null,
					amountMatch: !!near && e.amount >= near.gte && e.amount <= near.lte,
				}));
			})();
		}

		if (wants("payments") && has("PAYMENT_READ")) {
			jobs.payments = (async () => {
				const or = [{ pvNo: contains }, { bankSlipNo: contains }, { remarks: contains }, { vendor: { vendorName: contains } }, { customer: { customerName: contains } }];
				if (near) or.push({ amount: near });
				const rows = await prisma.vendorCustomerPayment.findMany({
					where: { OR: or },
					orderBy: { transactionDate: "desc" },
					take: limit,
					select: { id: true, partyType: true, pvNo: true, amount: true, method: true, transactionDate: true, vendor: { select: { vendorName: true } }, customer: { select: { customerName: true } } },
				});
				return rows.map((p) => ({
					id: p.id,
					partyType: p.partyType,
					pvNo: p.pvNo,
					amount: p.amount,
					method: p.method,
					transactionDate: p.transactionDate,
					partyName: p.vendor?.vendorName || p.customer?.customerName || null,
					amountMatch: !!near && p.amount >= near.gte && p.amount <= near.lte,
				}));
			})();
		}

		// one group failing must never blank the whole box
		const data = {};
		await Promise.all(
			Object.entries(jobs).map(async ([key, job]) => {
				try {
					data[key] = await job;
				} catch (err) {
					console.error(`Search (${key}) failed:`, err.message);
					data[key] = [];
				}
			}),
		);

		res.json({ success: true, q, amount: num, data });
	} catch (err) {
		console.error("Search failed:", err);
		res.status(500).json({ success: false, error: "Search failed" });
	}
});

export default router;
