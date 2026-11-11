import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import PushNotifications from "@pusher/push-notifications-server";

// Notifications for the ADMINS: what was created / changed in the system, kept in the Notification
// table (the header bell lists them) and — when Pusher Beams is configured — sent as a push too.
//
// Nothing in the route files has to change: `watch(spec)` wraps a router, and after a SUCCESSFUL
// create / update it loads the record, describes it (and, for an update, what changed from → to)
// and stores the notification. It runs after the response is sent and can never fail a request.

const prisma = new PrismaClient();

/* ----------------------------- formatting ----------------------------- */
export const money = (n) => `SAR ${(Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const nice = (v) => String(v || "").toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const show = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));

// [label, value-reader, kind]  kind: "money" | "date" | "enum" | undefined
const fmt = (v, kind) => {
	if (v === null || v === undefined || v === "") return null;
	if (kind === "money") return money(v);
	if (kind === "date") return day(v);
	if (kind === "enum") return nice(v);
	if (typeof v === "boolean") return v ? "Yes" : "No";
	return String(v);
};

/** [{field, from, to}] for every field in `spec` whose value is different. */
export function diff(before, after, spec, prefix = "") {
	const out = [];
	for (const [label, read, kind] of spec) {
		const a = fmt(read(before), kind);
		const b = fmt(read(after), kind);
		if (a !== b) out.push({ field: prefix ? `${label} (${prefix})` : label, from: show(a), to: show(b) });
	}
	return out;
}

const line = (label, value) => (value === null || value === undefined || value === "" ? null : `${label}: ${value}`);
const lines = (...l) => l.filter(Boolean);

/* ----------------------------- storing + pushing ----------------------------- */
const beams =
	process.env.BEAMS_INSTANCE_ID && process.env.BEAMS_SECRET_KEY
		? new PushNotifications({ instanceId: process.env.BEAMS_INSTANCE_ID, secretKey: process.env.BEAMS_SECRET_KEY })
		: null;

export const pushEnabled = () => !!beams;
export const beamsToken = (userId) => (beams ? beams.generateToken(String(userId)) : null);

export const adminUserIds = async () => {
	const admins = await prisma.user.findMany({
		where: { isActive: true, role: { name: { in: ["ADMIN", "Admin", "admin"] } } },
		select: { id: true },
	});
	return admins.map((a) => a.id);
};

async function push(row, excludeUserId) {
	if (!beams) return;
	const ids = (await adminUserIds()).filter((id) => id !== excludeUserId);
	if (!ids.length) return;
	const changeLines = (row.changes || []).slice(0, 3).map((c) => `${c.field}: ${c.from} → ${c.to}`);
	const body = [row.message, ...changeLines].join("\n").slice(0, 300);
	const front = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
	for (let i = 0; i < ids.length; i += 1000) {
		await beams.publishToUsers(ids.slice(i, i + 1000), {
			web: { notification: { title: row.title, body, ...(front && row.link ? { deep_link: `${front}${row.link}` } : {}), ...(front ? { icon: `${front}/android-chrome-192x192.png` } : {}) } },
		});
	}
}

/** Stores a notification (always) and pushes it to the admins (when Beams is set up). */
export async function notify({ type, title, message, details = [], changes = [], entityType, entityId, link, branchId, actor }) {
	const row = await prisma.notification.create({
		data: {
			type,
			title,
			message,
			details,
			changes,
			entityType: entityType || null,
			entityId: entityId ? String(entityId) : null,
			link: link || null,
			actorId: actor?.id || null,
			actorName: actor?.fullName || null,
			branchId: branchId || null,
		},
	});
	try {
		await push(row, actor?.id);
	} catch (err) {
		console.error("Push notification failed:", err.message);
	}
	return row;
}

const actorOf = (req) => {
	try {
		const token = (req.headers.authorization || "").split(" ")[1];
		const d = jwt.verify(token, process.env.JWT_SECRET);
		return { id: d.id, fullName: d.fullName || d.email || null };
	} catch {
		return null;
	}
};

/* ----------------------------- the watcher ----------------------------- */
/**
 * spec = {
 *   load(id)  -> the record (with what the description needs), or null
 *   rules: [{ method, path: RegExp (relative to the router), action: "create" | "update" | "event",
 *             id?: (body, req, match) => id of the record,   // default: first path group
 *             resolve?: async (id) => id }]                   // e.g. sale id -> invoice id
 *   describe({ action, rule, before, after, req, body, actor }) -> notification fields, or null
 * }
 */
export const watch = (spec) => (req, res, next) => {
	const rule = spec.rules.find((r) => r.method === req.method && r.path.test(req.path));
	if (!rule) return next();
	const match = req.path.match(rule.path);

	(async () => {
		let before = null;
		if (rule.action === "update" || rule.action === "event") {
			try {
				let id = match[1];
				if (rule.resolve) id = await rule.resolve(id);
				before = id ? await spec.load(id) : null;
			} catch {
				before = null;
			}
		}
		const original = res.json.bind(res);
		res.json = (payload) => {
			try {
				if (res.statusCode < 400 && payload && payload.success !== false) {
					const actor = actorOf(req);
					setImmediate(async () => {
						try {
							let id = rule.id ? rule.id(payload, req, match) : match[1];
							if (rule.resolve && !rule.id) id = await rule.resolve(id);
							if (!id) return;
							const after = await spec.load(String(id));
							if (!after) return;
							const n = spec.describe({ action: rule.action, rule, before, after, req, body: payload, actor });
							if (n) await notify({ ...n, actor });
						} catch (err) {
							console.error("Notification skipped:", err.message);
						}
					});
				}
			} catch {
				/* never touches the response */
			}
			return original(payload);
		};
		next();
	})();
};

/* ============================ SALES / HOTEL / VOID ============================ */
const invoiceInclude = {
	user: { select: { fullName: true } },
	branch: { select: { name: true, code: true } },
	sales: {
		orderBy: { createdAt: "asc" },
		include: {
			airline: { select: { iataName: true, airlineCode: true, airlineName: true } },
			vendor: { select: { vendorName: true } },
			customer: { select: { customerName: true } },
		},
	},
};
const loadInvoice = (id) => prisma.salesInvoice.findUnique({ where: { id }, include: invoiceInclude }).catch(() => null);
const saleToInvoiceId = async (saleId) => (await prisma.sale.findUnique({ where: { id: saleId }, select: { invoiceId: true } }).catch(() => null))?.invoiceId || null;

const kindOf = (inv) => {
	if (inv.sales.some((s) => s.status === "VOID")) return "VOID";
	if (inv.sales.some((s) => s.saleType === "HOTEL")) return "HOTEL";
	return "SALE";
};
const KIND = {
	SALE: { word: "Sale", created: "SALE_CREATED", updated: "SALE_UPDATED" },
	HOTEL: { word: "Hotel booking", created: "HOTEL_CREATED", updated: "HOTEL_UPDATED" },
	VOID: { word: "Void sale", created: "VOID_CREATED", updated: "VOID_UPDATED" },
};
const airlineOf = (s) => s.airline?.iataName || s.airline?.airlineCode || s.airline?.airlineName;

const lineSpec = [
	["Sale price", (s) => s.sellPrice, "money"],
	["Net price", (s) => s.netPrice, "money"],
	["Payment type", (s) => s.paymentType, "enum"],
	["Paid amount", (s) => s.paidAmount, "money"],
	["Customer", (s) => s.customer?.customerName],
	["Vendor", (s) => s.vendor?.vendorName],
	["Airline", airlineOf],
	["Document no.", (s) => s.documentNo],
	["Passenger", (s) => s.paxName],
	["PNR", (s) => s.pnr],
	["Status", (s) => s.status, "enum"],
	["Hotel", (s) => s.hotelName],
	["Check-in", (s) => s.checkInDate, "date"],
	["Check-out", (s) => s.checkOutDate, "date"],
	["Remarks", (s) => s.remarks],
];
const invoiceSpec = [
	["Sale date", (i) => i.saleDate, "date"],
	["Branch", (i) => i.branch?.name],
];

export const describeInvoice = ({ action, before, after }) => {
	const k = KIND[kindOf(after)];
	const first = after.sales[0] || {};
	const where = after.branch?.name;

	if (action === "create") {
		const isVoid = k === KIND.VOID;
		const total = after.sales.reduce((a, s) => a + (Number(s.sellPrice) || 0), 0);
		return {
			type: k.created,
			title: `${k.word} created`,
			message: isVoid
				? `${k.word} created with ${after.invoiceNo}${first.documentNo ? ` for ticket ${first.documentNo}` : ""}`
				: `${k.word} created with ${after.invoiceNo} of ${money(total)} (sale price)`,
			details: lines(
				line("Customer", first.customer?.customerName),
				line("Vendor", first.vendor?.vendorName),
				line("Airline", airlineOf(first)),
				line("Document no.", after.sales.map((s) => s.documentNo).filter(Boolean).join(", ")),
				line("Passenger", first.paxName),
				line("Hotel", first.hotelName),
				line("Stay", first.checkInDate ? `${day(first.checkInDate)} → ${day(first.checkOutDate)}` : null),
				line("Net price", isVoid ? null : money(after.sales.reduce((a, s) => a + (Number(s.netPrice) || 0), 0))),
				line("Profit", isVoid ? null : money(after.totalProfit)),
				line("Payment", nice(first.paymentType)),
				line("Tickets / lines", after.sales.length > 1 ? after.sales.length : null),
				line("Branch", where),
				line("Created by", after.user?.fullName),
			),
			entityType: "SalesInvoice",
			entityId: after.id,
			link: `/view-invoice/${after.id}`,
			branchId: after.branchId,
		};
	}

	// update: the invoice, then every ticket / line (matched by document number, else by position)
	if (!before) return null;
	const changes = diff(before, after, invoiceSpec);
	const keyOf = (s, i, list) => {
		const dup = s.documentNo && list.filter((x) => x.documentNo === s.documentNo).length === 1;
		return dup ? `doc:${s.documentNo}` : `idx:${i}`;
	};
	const beforeMap = new Map(before.sales.map((s, i) => [keyOf(s, i, before.sales), s]));
	const seen = new Set();
	after.sales.forEach((s, i) => {
		const key = keyOf(s, i, after.sales);
		const old = beforeMap.get(key);
		seen.add(key);
		const label = after.sales.length > 1 ? s.documentNo || `line ${i + 1}` : "";
		if (old) changes.push(...diff(old, s, lineSpec, label));
		else changes.push({ field: "Line added", from: "—", to: s.documentNo || `line ${i + 1}` });
	});
	for (const [key, s] of beforeMap) if (!seen.has(key)) changes.push({ field: "Line removed", from: s.documentNo || key, to: "—" });
	if (!changes.length) return null;

	return {
		type: k.updated,
		title: `${k.word} updated`,
		message: `${k.word} ${after.invoiceNo} (${money(after.sales.reduce((a, s) => a + (Number(s.sellPrice) || 0), 0))}) was updated — ${changes.length} change${changes.length > 1 ? "s" : ""}`,
		details: lines(line("Customer", first.customer?.customerName), line("Branch", where)),
		changes,
		entityType: "SalesInvoice",
		entityId: after.id,
		link: `/view-invoice/${after.id}`,
		branchId: after.branchId,
	};
};

export const salesWatch = watch({
	load: loadInvoice,
	rules: [
		{ method: "POST", path: /^\/$/, action: "create", id: (b) => b.data?.id || b.data?.invoiceId || b.data?.invoice?.id },
		{ method: "PUT", path: /^\/void\/([^/]+)$/, action: "update", resolve: saleToInvoiceId },
		{ method: "PUT", path: /^\/([^/]+)$/, action: "update" },
	],
	describe: describeInvoice,
});

/* ============================ REFUNDS ============================ */
const loadRefund = (id) =>
	prisma.refund
		.findUnique({
			where: { id },
			include: {
				bank: { select: { bankName: true } },
				processedBy: { select: { fullName: true } },
				sale: { select: { documentNo: true, paxName: true, invoice: { select: { invoiceNo: true, branchId: true } }, customer: { select: { customerName: true } }, vendor: { select: { vendorName: true } } } },
			},
		})
		.catch(() => null);

const refundSpec = [
	["Status", (r) => r.status, "enum"],
	["Customer refund", (r) => r.customerRefundAmount, "money"],
	["Vendor refund", (r) => r.vendorRefundAmount, "money"],
	["Refund fee", (r) => r.refundFee, "money"],
	["Cancellation charges", (r) => r.cancellationCharges, "money"],
	["Net refund to customer", (r) => r.netRefundToCustomer, "money"],
	["Paid out via", (r) => r.refundType, "enum"],
	["Bank", (r) => r.bank?.bankName],
	["Refund date", (r) => r.refundDate, "date"],
	["Reason", (r) => r.refundReason],
	["Remarks", (r) => r.remarks],
];
export const refundsWatch = watch({
	load: loadRefund,
	rules: [
		{ method: "POST", path: /^\/$/, action: "create", id: (b) => b.data?.refund?.id || b.data?.id },
		{ method: "PUT", path: /^\/([^/]+)$/, action: "update" },
	],
	describe: ({ action, before, after }) => {
		const inv = after.sale?.invoice?.invoiceNo;
		const base = {
			entityType: "Refund",
			entityId: after.id,
			link: "/sales-report",
			branchId: after.sale?.invoice?.branchId,
		};
		const who = lines(line("Invoice", inv), line("Customer", after.sale?.customer?.customerName), line("Vendor", after.sale?.vendor?.vendorName), line("Document no.", after.sale?.documentNo), line("Passenger", after.sale?.paxName));
		if (action === "create") {
			return {
				...base,
				type: "REFUND_CREATED",
				title: "Refund created",
				message: `Refund created for ${inv || "a sale"} — ${money(after.netRefundToCustomer)} to the customer (${nice(after.status)})`,
				details: lines(...who, line("Sale amount", money(after.originalSaleAmount)), line("Refund fee", after.refundFee ? money(after.refundFee) : null), line("Paid out via", nice(after.refundType)), line("Reason", after.refundReason)),
			};
		}
		const changes = before ? diff(before, after, refundSpec) : [];
		if (!changes.length) return null;
		return { ...base, type: "REFUND_UPDATED", title: "Refund updated", message: `Refund for ${inv || "a sale"} was updated — ${changes.length} change${changes.length > 1 ? "s" : ""}`, details: who, changes };
	},
});

/* ============================ OTHER SERVICES ============================ */
const loadOther = (id) => prisma.otherServiceInvoice.findUnique({ where: { id }, include: { bank: { select: { bankName: true } }, user: { select: { fullName: true } } } }).catch(() => null);
const otherSpec = [
	["Customer", (o) => o.customerName],
	["Service", (o) => o.serviceType, "enum"],
	["Invoice date", (o) => o.invoiceDate, "date"],
	["Total", (o) => o.total, "money"],
	["Discount", (o) => o.discount, "money"],
	["Status", (o) => o.status, "enum"],
	["Payment", (o) => o.paymentMethod, "enum"],
	["Bank", (o) => o.bank?.bankName],
	["Reference", (o) => o.referenceNo],
	["Payment terms", (o) => o.paymentTerms],
];
const paidVia = (o) => (o.status !== "CONFIRMED" ? null : o.paymentMethod === "BANK" ? `Bank${o.bank?.bankName ? ` — ${o.bank.bankName}` : ""}` : nice(o.paymentMethod));
export const otherServicesWatch = watch({
	load: loadOther,
	rules: [
		{ method: "POST", path: /^\/$/, action: "create", id: (b) => b.data?.id },
		{ method: "POST", path: /^\/([^/]+)\/confirm$/, action: "event" },
		{ method: "PUT", path: /^\/([^/]+)$/, action: "update" },
	],
	describe: ({ action, before, after }) => {
		const base = { entityType: "OtherServiceInvoice", entityId: after.id, link: `/other-services/${after.id}`, branchId: after.branchId };
		const facts = lines(line("Service", nice(after.serviceType)), line("Customer", after.customerName), line("Amount excl. VAT", money(after.netAmount)), line("VAT", money(after.vatAmount)), line("Payment", paidVia(after)), line("Created by", after.user?.fullName));
		if (action === "create") {
			return { ...base, type: "OTHER_SERVICE_CREATED", title: after.status === "DRAFT" ? "Other service saved as draft" : "Other service created", message: `Other service ${after.invoiceNo} ${after.status === "DRAFT" ? "saved as a draft" : "created"} for ${after.customerName} of ${money(after.total)}`, details: facts };
		}
		if (action === "event") {
			return { ...base, type: "OTHER_SERVICE_CONFIRMED", title: "Other service confirmed", message: `Other service ${after.invoiceNo} confirmed — ${money(after.total)} received${paidVia(after) ? ` (${paidVia(after)})` : ""}`, details: facts };
		}
		const changes = before ? diff(before, after, otherSpec) : [];
		if (!changes.length) return null;
		return { ...base, type: "OTHER_SERVICE_UPDATED", title: "Other service updated", message: `Other service ${after.invoiceNo} was updated — ${changes.length} change${changes.length > 1 ? "s" : ""}`, details: facts, changes };
	},
});

/* ============================ EXPENSES ============================ */
const loadExpense = (id) =>
	prisma.expense
		.findUnique({ where: { id }, include: { branch: { select: { name: true } }, bank: { select: { bankName: true } }, user: { select: { fullName: true } }, createdBy: { select: { fullName: true } } } })
		.catch(() => null);
const expenseSpec = [
	["Amount", (e) => e.amount, "money"],
	["VAT", (e) => e.vatAmount, "money"],
	["Category", (e) => e.category, "enum"],
	["Payment mode", (e) => e.paymentMode, "enum"],
	["Bank", (e) => e.bank?.bankName],
	["Branch", (e) => e.branch?.name],
	["Status", (e) => e.status, "enum"],
	["Expense date", (e) => e.expenseDate, "date"],
	["Employee", (e) => e.user?.fullName],
	["Description", (e) => e.description],
];
export const expensesWatch = watch({
	load: loadExpense,
	rules: [
		{ method: "POST", path: /^\/$/, action: "create", id: (b) => b.data?.id },
		{ method: "PUT", path: /^\/([^/]+)$/, action: "update" },
	],
	describe: ({ action, before, after }) => {
		const base = { entityType: "Expense", entityId: after.id, link: "/expenses", branchId: after.branchId };
		const facts = lines(line("Category", nice(after.category)), line("Branch", after.branch?.name), line("Paid by", after.paymentMode === "BANK_TRANSFER" ? `Bank${after.bank?.bankName ? ` — ${after.bank.bankName}` : ""}` : nice(after.paymentMode)), line("Employee", after.user?.fullName), line("Description", after.description), line("Created by", after.createdBy?.fullName));
		if (action === "create") return { ...base, type: "EXPENSE_CREATED", title: "Expense created", message: `Expense of ${money(after.amount)} created — ${nice(after.category)}`, details: facts };
		const changes = before ? diff(before, after, expenseSpec) : [];
		if (!changes.length) return null;
		return { ...base, type: "EXPENSE_UPDATED", title: "Expense updated", message: `Expense of ${money(after.amount)} (${nice(after.category)}) was updated — ${changes.length} change${changes.length > 1 ? "s" : ""}`, details: facts, changes };
	},
});

/* ============================ PAYMENTS (vendor / customer) ============================ */
const loadVcPayment = (id) =>
	prisma.vendorCustomerPayment
		.findUnique({
			where: { id },
			include: { vendor: { select: { vendorName: true } }, customer: { select: { customerName: true } }, bank: { select: { bankName: true } }, createdBy: { select: { fullName: true } }, sale: { select: { documentNo: true, invoice: { select: { invoiceNo: true } } } } },
		})
		.catch(() => null);
const partyOf = (p) => p.vendor?.vendorName || p.customer?.customerName || (p.saleId ? "walk-in customer" : "—");
const paymentSpec = [
	["Amount", (p) => p.amount, "money"],
	["Method", (p) => p.method, "enum"],
	["Bank", (p) => p.bank?.bankName],
	["Payment date", (p) => p.transactionDate, "date"],
	["Bank slip no.", (p) => p.bankSlipNo],
	["PV no.", (p) => p.pvNo],
	["Remarks", (p) => p.remarks],
	["Paid to / received from", partyOf],
];
export const vendorCustomerPaymentsWatch = watch({
	load: loadVcPayment,
	rules: [
		{ method: "POST", path: /^\/$/, action: "create", id: (b) => b.data?.id },
		{ method: "PUT", path: /^\/([^/]+)$/, action: "update" },
	],
	describe: ({ action, before, after }) => {
		const vendor = after.partyType === "VENDOR";
		const base = { entityType: "VendorCustomerPayment", entityId: after.id, link: "/new-payments", branchId: after.branchId };
		const via = after.method === "BANK_TRANSFER" ? `Bank${after.bank?.bankName ? ` — ${after.bank.bankName}` : ""}` : nice(after.method);
		const facts = lines(line(vendor ? "Vendor" : "Customer", partyOf(after)), line("Method", via), line("PV no.", after.pvNo), line("Invoice", after.sale?.invoice?.invoiceNo), line("Bank slip no.", after.bankSlipNo), line("Remarks", after.remarks), line("Recorded by", after.createdBy?.fullName));
		if (action === "create") {
			return { ...base, type: "PAYMENT_CREATED", title: vendor ? "Payment made" : "Payment received", message: vendor ? `Payment of ${money(after.amount)} made to ${partyOf(after)} (${via})` : `Payment of ${money(after.amount)} received from ${partyOf(after)} (${via})`, details: facts };
		}
		const changes = before ? diff(before, after, paymentSpec) : [];
		if (!changes.length) return null;
		return { ...base, type: "PAYMENT_UPDATED", title: "Payment updated", message: `Payment of ${money(after.amount)} ${vendor ? "to" : "from"} ${partyOf(after)} was updated — ${changes.length} change${changes.length > 1 ? "s" : ""}`, details: facts, changes };
	},
});

/* ============================ PAYMENTS recorded on a sale ============================ */
const loadSalePayment = (id) => prisma.salePayment.findUnique({ where: { id }, include: { bank: { select: { bankName: true } }, sale: { select: { documentNo: true, invoice: { select: { invoiceNo: true, branchId: true } }, customer: { select: { customerName: true } } } } } }).catch(() => null);
export const salePaymentsWatch = watch({
	load: loadSalePayment,
	rules: [{ method: "POST", path: /^\/([^/]+)$/, action: "create", id: (b) => b.data?.payment?.id }],
	describe: ({ after }) => {
		const inv = after.sale?.invoice?.invoiceNo;
		const via = after.method === "BANK_TRANSFER" ? `Bank${after.bank?.bankName ? ` — ${after.bank.bankName}` : ""}` : nice(after.method);
		return {
			type: "PAYMENT_CREATED",
			title: "Payment received",
			message: `Payment of ${money(after.amount)} received on ${inv || "a sale"} (${via})`,
			details: lines(line("Customer", after.sale?.customer?.customerName), line("Document no.", after.sale?.documentNo), line("Remarks", after.remarks)),
			entityType: "SalePayment",
			entityId: after.id,
			link: "/sales-report",
			branchId: after.sale?.invoice?.branchId,
		};
	},
});

/* ============================ BALANCE ADJUSTMENTS ============================ */
const loadAdjustment = (id) => prisma.balanceAdjustment.findUnique({ where: { id }, include: { bank: { select: { bankName: true } }, account: { select: { name: true, type: true } }, createdBy: { select: { fullName: true } } } }).catch(() => null);
const adjustmentSpec = [
	["Amount", (a) => a.amount, "money"],
	["Type", (a) => a.type, "enum"],
	["Method", (a) => a.method, "enum"],
	["Bank", (a) => a.bank?.bankName],
	["Date", (a) => a.adjustmentDate, "date"],
	["Reason", (a) => a.reason],
	["Reference no.", (a) => a.referenceNo],
	["Remarks", (a) => a.remarks],
];
export const balanceAdjustmentsWatch = watch({
	load: loadAdjustment,
	rules: [
		{ method: "POST", path: /^\/$/, action: "create", id: (b) => b.data?.id },
		{ method: "PUT", path: /^\/([^/]+)$/, action: "update" },
	],
	describe: ({ action, before, after }) => {
		const target = after.bank?.bankName ? `Bank — ${after.bank.bankName}` : after.account?.name || nice(after.method);
		const verb = after.type === "ADD" ? "added to" : "taken from";
		const base = { entityType: "BalanceAdjustment", entityId: after.id, link: "/balance-adjustments" };
		const facts = lines(line("Account", target), line("Reason", after.reason), line("Balance", `${money(after.balanceBefore)} → ${money(after.balanceAfter)}`), line("Reference no.", after.referenceNo), line("Remarks", after.remarks), line("Created by", after.createdBy?.fullName));
		if (action === "create") return { ...base, type: "BALANCE_ADJUSTMENT_CREATED", title: "Balance adjustment", message: `${money(after.amount)} ${verb} ${target}`, details: facts };
		const changes = before ? diff(before, after, adjustmentSpec) : [];
		if (!changes.length) return null;
		return { ...base, type: "BALANCE_ADJUSTMENT_UPDATED", title: "Balance adjustment updated", message: `Balance adjustment on ${target} (${money(after.amount)}) was updated — ${changes.length} change${changes.length > 1 ? "s" : ""}`, details: facts, changes };
	},
});
