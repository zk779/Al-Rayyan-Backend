import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { generateNextOtherServiceNo, previewNextOtherServiceNo } from "../utils/otherServiceCounter.js";
import { localDayRangeToUtc } from "../utils/dateRange.js";

// Invoices for services that are not ticket sales or hotel bookings — transportation, Umrah visa,
// NADRA … Their own table and number series. Customer details are typed on the invoice; nothing
// here touches a ledger, a customer or a vendor.

const router = express.Router();
const prisma = new PrismaClient();

const VAT_RATE = 0.15;
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

/* --------------------------- 🔐 AUTH MIDDLEWARE --------------------------- */
async function authenticate(req, res, next) {
	const authHeader = req.headers.authorization;
	if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });

	const token = authHeader.split(" ")[1];
	try {
		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		const user = await prisma.user.findUnique({
			where: { id: decoded.id },
			include: { role: { include: { permissionLinks: { include: { permission: true } } } } },
		});
		if (!user || !user.isActive) return res.status(401).json({ error: "User inactive or removed" });

		req.user = {
			...decoded,
			permissions: user.role?.permissionLinks.map((link) => link.permission.name) || [],
		};
		next();
	} catch (err) {
		return res.status(401).json({ error: "Invalid or expired token" });
	}
}

// Same visibility rule as sales: everything / own branch / own invoices
const scopeFilter = (req) => {
	const permissions = req.user.permissions || [];
	if (permissions.includes("SALE_VIEW_ALL")) return null;
	if (permissions.includes("SALE_VIEW_BRANCH")) return { branchId: req.user.branchId || null };
	return { userId: req.user.id };
};

/* ----------------------- validation + the money ----------------------- */
const text = (v, max = 500) => {
	const s = String(v ?? "").trim();
	return s ? s.slice(0, max) : null;
};

/**
 * Validates the body and works out every amount (the server is the single source of the figures).
 *   pricesIncludeVat = true : the typed rates already include 15% VAT  -> net = total / 1.15
 *   pricesIncludeVat = false: the typed rates are before VAT           -> VAT = 15% of net
 * Either way netAmount is the amount EXCLUDING VAT.
 */
function normalize(body) {
	const customerName = text(body.customerName, 200);
	if (!customerName) throw new Error("Customer name is required");

	const invoiceDate = body.invoiceDate ? new Date(body.invoiceDate) : new Date();
	if (isNaN(invoiceDate.getTime())) throw new Error("Invalid invoice date");

	const serviceType = String(body.serviceType || "")
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 40);
	if (!serviceType) throw new Error("Service type is required");

	if (!Array.isArray(body.items) || body.items.length === 0) throw new Error("Add at least one line to the invoice");
	if (body.items.length > 100) throw new Error("An invoice can have at most 100 lines");
	const items = body.items.map((it, i) => {
		const description = text(it.description, 500);
		const qty = Number(it.qty);
		const rate = Number(it.rate);
		if (!description) throw new Error(`Line ${i + 1}: description is required`);
		if (!isFinite(qty) || qty <= 0) throw new Error(`Line ${i + 1}: quantity must be more than 0`);
		if (!isFinite(rate) || rate < 0) throw new Error(`Line ${i + 1}: rate cannot be negative`);
		return { description, detail: text(it.detail, 200), qty, unit: text(it.unit, 40), rate, amount: round2(qty * rate) };
	});

	const notes = (Array.isArray(body.notes) ? body.notes : [])
		.map((n) => ({ label: text(n?.label, 80), value: text(n?.value, 500) }))
		.filter((n) => n.label && n.value)
		.slice(0, 20);

	const pricesIncludeVat = body.pricesIncludeVat !== false;
	const subtotal = round2(items.reduce((a, it) => a + it.amount, 0));
	const discount = round2(Number(body.discount) || 0);
	if (discount < 0) throw new Error("Discount cannot be negative");
	if (discount > subtotal) throw new Error("Discount cannot be more than the invoice total");

	const afterDiscount = round2(subtotal - discount);
	let netAmount, vatAmount, total;
	if (pricesIncludeVat) {
		total = afterDiscount;
		netAmount = round2(total / (1 + VAT_RATE));
		vatAmount = round2(total - netAmount);
	} else {
		netAmount = afterDiscount;
		vatAmount = round2(netAmount * VAT_RATE);
		total = round2(netAmount + vatAmount);
	}

	return {
		invoiceDate,
		serviceType,
		detailLabel: text(body.detailLabel, 60),
		referenceNo: text(body.referenceNo, 80),
		projectLocation: text(body.projectLocation, 200),
		paymentTerms: text(body.paymentTerms, 120),
		customerName,
		customerCrNo: text(body.customerCrNo, 60),
		customerVatNo: text(body.customerVatNo, 60),
		contactPerson: text(body.contactPerson, 120),
		customerPhone: text(body.customerPhone, 60),
		customerEmail: text(body.customerEmail, 120),
		customerAddress: text(body.customerAddress, 400),
		items,
		notes,
		pricesIncludeVat,
		subtotal,
		discount,
		netAmount,
		vatAmount,
		total,
	};
}

const withUser = { user: { select: { id: true, fullName: true, email: true } } };

/* ----------------------- NEXT NUMBER (read-only preview) ----------------------- */
// GET /api/other-services/next-number?invoiceDate=2026-11-06 — what the next invoice will be called
router.get("/next-number", authenticate, async (req, res) => {
	try {
		const date = req.query.invoiceDate ? new Date(req.query.invoiceDate) : new Date();
		if (isNaN(date.getTime())) return res.status(400).json({ success: false, error: "Invalid invoiceDate" });
		const { invoiceNo, key, lastNumber } = await previewNextOtherServiceNo(prisma, date);
		res.json({ success: true, invoiceNo, key, lastNumber });
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to get the next invoice number" });
	}
});

/* ----------------------- LIST ----------------------- */
// GET /api/other-services?search=&serviceType=&dateFrom=&dateTo=&tz=&order=asc|desc
router.get("/", authenticate, async (req, res) => {
	try {
		const { search, serviceType, dateFrom, dateTo, tz, order } = req.query;
		const filters = [];
		const scope = scopeFilter(req);
		if (scope) filters.push(scope);

		if (search) {
			filters.push({
				OR: [
					{ invoiceNo: { contains: String(search), mode: "insensitive" } },
					{ customerName: { contains: String(search), mode: "insensitive" } },
					{ referenceNo: { contains: String(search), mode: "insensitive" } },
					{ customerPhone: { contains: String(search), mode: "insensitive" } },
					{ customerCrNo: { contains: String(search), mode: "insensitive" } },
				],
			});
		}
		if (serviceType && serviceType !== "all") filters.push({ serviceType: String(serviceType).toUpperCase() });

		// a text search looks across every date, like the sales report
		if ((dateFrom || dateTo) && !search) {
			const range = {};
			const from = localDayRangeToUtc(dateFrom, tz);
			if (from) range.gte = from.start;
			const to = localDayRangeToUtc(dateTo, tz);
			if (to) range.lte = to.end;
			if (Object.keys(range).length) filters.push({ invoiceDate: range });
		}

		const where = filters.length ? { AND: filters } : {};
		const data = await prisma.otherServiceInvoice.findMany({
			where,
			orderBy: [{ invoiceDate: String(order).toLowerCase() === "asc" ? "asc" : "desc" }, { createdAt: "desc" }],
			include: withUser,
		});

		const sum = (key) => round2(data.reduce((a, d) => a + Number(d[key] || 0), 0));
		res.json({
			success: true,
			data,
			summary: { count: data.length, netAmount: sum("netAmount"), vatAmount: sum("vatAmount"), total: sum("total") },
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to fetch other-service invoices" });
	}
});

/* ----------------------- ONE ----------------------- */
router.get("/:id", authenticate, async (req, res) => {
	try {
		const scope = scopeFilter(req);
		const invoice = await prisma.otherServiceInvoice.findFirst({
			where: { AND: [{ id: req.params.id }, ...(scope ? [scope] : [])] },
			include: withUser,
		});
		if (!invoice) return res.status(404).json({ success: false, error: "Invoice not found" });
		res.json({ success: true, data: invoice });
	} catch (err) {
		console.error(err);
		res.status(400).json({ success: false, error: "Failed to fetch the invoice" });
	}
});

/* ----------------------- CREATE ----------------------- */
router.post("/", authenticate, async (req, res) => {
	try {
		const data = normalize(req.body || {});
		const invoice = await prisma.$transaction(async (tx) => {
			const invoiceNo = await generateNextOtherServiceNo(tx, data.invoiceDate);
			return tx.otherServiceInvoice.create({
				data: { ...data, invoiceNo, userId: req.user.id, branchId: req.user.branchId || null },
			});
		});
		res.status(201).json({ success: true, message: "Invoice created", data: invoice });
	} catch (err) {
		console.error(err);
		res.status(400).json({ success: false, error: err.message });
	}
});

/* ----------------------- UPDATE (the number never changes) ----------------------- */
router.put("/:id", authenticate, async (req, res) => {
	try {
		const scope = scopeFilter(req);
		const existing = await prisma.otherServiceInvoice.findFirst({
			where: { AND: [{ id: req.params.id }, ...(scope ? [scope] : [])] },
			select: { id: true },
		});
		if (!existing) return res.status(404).json({ success: false, error: "Invoice not found" });

		const data = normalize(req.body || {});
		const invoice = await prisma.otherServiceInvoice.update({ where: { id: existing.id }, data });
		res.json({ success: true, message: "Invoice updated", data: invoice });
	} catch (err) {
		console.error(err);
		res.status(400).json({ success: false, error: err.message });
	}
});

/* ----------------------- DELETE ----------------------- */
router.delete("/:id", authenticate, async (req, res) => {
	try {
		const scope = scopeFilter(req);
		const existing = await prisma.otherServiceInvoice.findFirst({
			where: { AND: [{ id: req.params.id }, ...(scope ? [scope] : [])] },
			select: { id: true },
		});
		if (!existing) return res.status(404).json({ success: false, error: "Invoice not found" });

		await prisma.otherServiceInvoice.delete({ where: { id: existing.id } });
		res.json({ success: true, message: "Invoice deleted" });
	} catch (err) {
		console.error(err);
		res.status(400).json({ success: false, error: err.message || "Failed to delete the invoice" });
	}
});

export default router;
