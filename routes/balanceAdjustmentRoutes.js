import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { localDayRangeToUtc } from "../utils/dateRange.js";

const router = express.Router();
const prisma = new PrismaClient();

/* --------------------------- 🔐 AUTH MIDDLEWARE --------------------------- */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ success: false, error: "Missing Authorization header" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user || !user.isActive)
      return res.status(401).json({ success: false, error: "User inactive or removed" });

    req.user = decoded;
    req.dbUser = user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
}

// Balance adjustments move real money figures, so unlike most routes the
// permission is enforced server-side too, not just by hiding UI.
const requirePermission = (permission) => async (req, res, next) => {
  try {
    const roleId = req.dbUser?.roleId;
    if (!roleId)
      return res.status(403).json({ success: false, error: "You do not have permission to do this" });

    const link = await prisma.rolePermission.findFirst({
      where: { roleId, permission: { name: permission } },
      select: { id: true },
    });
    if (!link)
      return res.status(403).json({ success: false, error: "You do not have permission to do this" });
    next();
  } catch (err) {
    console.error("Permission check failed:", err);
    res.status(500).json({ success: false, error: "Permission check failed" });
  }
};

const ADJUSTMENT_TYPES = ["ADD", "SUBTRACT"];
const ADJUSTMENT_METHODS = ["CASH", "BANK_TRANSFER"];
const EPS = 0.005;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Thrown inside transactions to roll back and return a clean 4xx.
class AdjustmentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const handleError = (res, err, fallback) => {
  if (err instanceof AdjustmentError)
    return res.status(err.status).json({ success: false, error: err.message });
  console.error(fallback, err);
  return res.status(500).json({ success: false, error: fallback });
};

const INCLUDE = {
  bank: { select: { id: true, bankName: true, accountNumber: true } },
  account: { select: { id: true, name: true, type: true, balance: true } },
  createdBy: { select: { id: true, fullName: true, email: true } },
};

const signed = (type, amount) => (type === "ADD" ? amount : -amount);

const ledgerRemarks = (adj) =>
  `Balance adjustment (${adj.type === "ADD" ? "Add" : "Subtract"}) — ${adj.reason}${
    adj.remarks ? `: ${adj.remarks}` : ""
  }`;

/* ------------------------------ validation ------------------------------ */
// Merges the request body over `existing` (for PUT), validates, and returns
// the normalised values. Throws AdjustmentError(400/404) on bad input.
function normalisePayload(body, existing = null) {
  const pick = (key, fallback) => (body[key] !== undefined ? body[key] : fallback);

  const method = pick("method", existing?.method);
  const type = pick("type", existing?.type);
  const rawAmount = pick("amount", existing?.amount);
  const reason = String(pick("reason", existing?.reason) ?? "").trim();
  const referenceNo = String(pick("referenceNo", existing?.referenceNo) ?? "").trim() || null;
  const remarks = String(pick("remarks", existing?.remarks) ?? "").trim() || null;
  const rawDate = pick("adjustmentDate", existing?.adjustmentDate ?? new Date());

  if (!ADJUSTMENT_METHODS.includes(method))
    throw new AdjustmentError(400, `method must be one of: ${ADJUSTMENT_METHODS.join(", ")}`);
  if (!ADJUSTMENT_TYPES.includes(type))
    throw new AdjustmentError(400, `type must be one of: ${ADJUSTMENT_TYPES.join(", ")}`);

  const amount = round2(rawAmount);
  if (rawAmount === undefined || rawAmount === null || rawAmount === "" || isNaN(amount) || amount <= 0)
    throw new AdjustmentError(400, "amount must be a number greater than 0");

  if (!reason) throw new AdjustmentError(400, "reason is required");

  const adjustmentDate = new Date(rawDate);
  if (isNaN(adjustmentDate.getTime()))
    throw new AdjustmentError(400, "adjustmentDate must be a valid date");

  // Bank rules: required for bank adjustments, forbidden for cash. When the
  // method is unchanged on an edit, the existing bank carries over.
  let bankId = null;
  if (method === "BANK_TRANSFER") {
    const carriedOver = existing?.method === "BANK_TRANSFER" ? existing.bankId : null;
    bankId = body.bankId !== undefined ? body.bankId : carriedOver;
    if (!bankId)
      throw new AdjustmentError(400, "bankId is required when method is BANK_TRANSFER");
  } else if (body.bankId) {
    throw new AdjustmentError(400, "bankId must not be set when method is CASH");
  }

  return { method, type, amount, reason, referenceNo, remarks, adjustmentDate, bankId };
}

// Resolves the ledger account an adjustment hits (inside the transaction).
async function resolveTarget(tx, { method, bankId }) {
  if (method === "BANK_TRANSFER") {
    const bank = await tx.bank.findUnique({ where: { id: bankId }, include: { account: true } });
    if (!bank) throw new AdjustmentError(404, "Bank not found");
    if (!bank.isActive) throw new AdjustmentError(400, "Bank account is inactive");
    return { account: bank.account, label: `${bank.bankName} (${bank.accountNumber})` };
  }

  let cash = await tx.account.findFirst({ where: { type: "CASH" } });
  if (!cash) cash = await tx.account.create({ data: { name: "Cash Account", type: "CASH", balance: 0 } });
  return { account: cash, label: "Cash" };
}

// Posts the balance change + its ledger entry. Returns the account's
// balance before/after.
async function applyAdjustment(tx, adjustmentId, accountId, v) {
  const delta = signed(v.type, v.amount);
  const updated = await tx.account.update({
    where: { id: accountId },
    data: { balance: { increment: delta } },
  });

  await tx.ledgerEntry.create({
    data: {
      accountId,
      entryType: "ADJUSTMENT",
      // credit = money added, debit = money taken away
      credit: v.type === "ADD" ? v.amount : 0,
      debit: v.type === "SUBTRACT" ? v.amount : 0,
      balanceAdjustmentId: adjustmentId,
      transactionDate: v.adjustmentDate,
      remarks: ledgerRemarks(v),
    },
  });

  return { balanceBefore: round2(updated.balance - delta), balanceAfter: round2(updated.balance) };
}

// Undoes a previously applied adjustment: reverses the balance change and
// removes its ledger entries.
async function reverseAdjustment(tx, adj) {
  await tx.account.update({
    where: { id: adj.accountId },
    data: { balance: { increment: -signed(adj.type, adj.amount) } },
  });
  await tx.ledgerEntry.deleteMany({ where: { balanceAdjustmentId: adj.id } });
}

// A SUBTRACT may never push an account below zero (same rule expenses follow:
// you can't pay out more than the balance). Only the *new* effect is checked --
// undoing an adjustment (delete, or editing an Add down) is never blocked, so
// mistakes can always be reversed, and an account that is already negative can
// still be corrected upward.
async function assertNotOverdrawn(tx, initialBalances) {
  for (const [accountId, initial] of initialBalances) {
    const acc = await tx.account.findUnique({ where: { id: accountId } });
    if (acc.balance < -EPS && acc.balance < initial - EPS) {
      const label = acc.type === "CASH" ? "cash" : acc.name || "bank";
      throw new AdjustmentError(
        400,
        `Insufficient ${label} balance. This change would leave the balance at ${round2(acc.balance)} (currently ${round2(initial)}).`,
      );
    }
  }
}

/* -------------------------------- CREATE -------------------------------- */
router.post("/", authenticate, requirePermission("BALANCE_ADJUSTMENT_CREATE"), async (req, res) => {
  try {
    const v = normalisePayload(req.body);

    const created = await prisma.$transaction(async (tx) => {
      const { account } = await resolveTarget(tx, v);
      const initial = new Map([[account.id, account.balance]]);

      const adjustment = await tx.balanceAdjustment.create({
        data: {
          adjustmentDate: v.adjustmentDate,
          method: v.method,
          type: v.type,
          amount: v.amount,
          reason: v.reason,
          referenceNo: v.referenceNo,
          remarks: v.remarks,
          bankId: v.bankId,
          accountId: account.id,
          balanceBefore: account.balance,
          balanceAfter: account.balance, // corrected right below
          createdById: req.user?.id ?? null,
        },
      });

      const snap = await applyAdjustment(tx, adjustment.id, account.id, v);
      if (v.type === "SUBTRACT") await assertNotOverdrawn(tx, initial);

      return tx.balanceAdjustment.update({
        where: { id: adjustment.id },
        data: snap,
        include: INCLUDE,
      });
    });

    res.status(201).json({ success: true, data: created });
  } catch (err) {
    handleError(res, err, "Failed to create balance adjustment");
  }
});

/* --------------------------------- LIST --------------------------------- */
// Filters: ?method=&type=&bankId=&reason=&createdById=&dateFrom=&dateTo=&timeZone=
//          &minAmount=&maxAmount=&search=&order=asc|desc&page=&limit=
// No date filter unless dateFrom and/or dateTo is given.
router.get("/", authenticate, requirePermission("BALANCE_ADJUSTMENT_READ"), async (req, res) => {
  try {
    const {
      method,
      type,
      bankId,
      reason,
      createdById,
      dateFrom,
      dateTo,
      timeZone,
      minAmount,
      maxAmount,
      search,
      order,
      page = 1,
      limit = 20,
    } = req.query;

    const where = {};
    if (method) where.method = method;
    if (type) where.type = type;
    if (bankId) where.bankId = bankId;
    if (createdById) where.createdById = createdById;
    if (reason) where.reason = { equals: String(reason), mode: "insensitive" };

    const dateFilter = {};
    if (dateFrom) {
      const range = localDayRangeToUtc(dateFrom, timeZone);
      if (range) dateFilter.gte = range.start;
    }
    if (dateTo) {
      const range = localDayRangeToUtc(dateTo, timeZone);
      if (range) dateFilter.lte = range.end;
    }
    if (Object.keys(dateFilter).length) where.adjustmentDate = dateFilter;

    const amountFilter = {};
    if (minAmount !== undefined && minAmount !== "" && !isNaN(Number(minAmount)))
      amountFilter.gte = Number(minAmount);
    if (maxAmount !== undefined && maxAmount !== "" && !isNaN(Number(maxAmount)))
      amountFilter.lte = Number(maxAmount);
    if (Object.keys(amountFilter).length) where.amount = amountFilter;

    const q = String(search || "").trim();
    if (q) {
      const contains = { contains: q, mode: "insensitive" };
      where.OR = [
        { reason: contains },
        { remarks: contains },
        { referenceNo: contains },
        { bank: { bankName: contains } },
        { createdBy: { fullName: contains } },
      ];
    }

    const take = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const currentPage = Math.max(Number(page) || 1, 1);
    const skip = (currentPage - 1) * take;
    const direction = String(order || "").toLowerCase() === "asc" ? "asc" : "desc";

    const [rows, total, byType] = await prisma.$transaction([
      prisma.balanceAdjustment.findMany({
        where,
        include: INCLUDE,
        orderBy: [{ adjustmentDate: direction }, { createdAt: direction }],
        skip,
        take,
      }),
      prisma.balanceAdjustment.count({ where }),
      // One grouped query so the summary always honours every active filter
      // (including type) instead of overriding it.
      prisma.balanceAdjustment.groupBy({
        by: ["type"],
        where,
        _sum: { amount: true },
        _count: { _all: true },
        orderBy: { type: "asc" },
      }),
    ]);

    const addedAgg = byType.find((g) => g.type === "ADD");
    const subtractedAgg = byType.find((g) => g.type === "SUBTRACT");
    const totalAdded = round2(addedAgg?._sum.amount || 0);
    const totalSubtracted = round2(subtractedAgg?._sum.amount || 0);

    res.status(200).json({
      success: true,
      data: rows,
      pagination: { page: currentPage, limit: take, total, pages: Math.max(Math.ceil(total / take), 1) },
      summary: {
        count: total,
        addedCount: addedAgg?._count._all || 0,
        subtractedCount: subtractedAgg?._count._all || 0,
        totalAdded,
        totalSubtracted,
        net: round2(totalAdded - totalSubtracted),
      },
    });
  } catch (err) {
    handleError(res, err, "Failed to fetch balance adjustments");
  }
});

/* ------------------------- CURRENT BALANCES (UI) ------------------------- */
// Current Cash balance + every active bank's balance, so the form can show
// "current -> new" before saving. Declared before /:id.
router.get("/balances", authenticate, requirePermission("BALANCE_ADJUSTMENT_READ"), async (req, res) => {
  try {
    const [cash, banks] = await Promise.all([
      prisma.account.findFirst({ where: { type: "CASH" }, select: { id: true, balance: true } }),
      prisma.bank.findMany({
        where: { isActive: true },
        select: { id: true, bankName: true, accountNumber: true, account: { select: { balance: true } } },
        orderBy: { bankName: "asc" },
      }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        cash: { accountId: cash?.id ?? null, balance: round2(cash?.balance ?? 0) },
        banks: banks.map((b) => ({
          id: b.id,
          bankName: b.bankName,
          accountNumber: b.accountNumber,
          balance: round2(b.account?.balance ?? 0),
        })),
      },
    });
  } catch (err) {
    handleError(res, err, "Failed to fetch balances");
  }
});

/* ------------------------------- GET BY ID ------------------------------- */
router.get("/:id", authenticate, requirePermission("BALANCE_ADJUSTMENT_READ"), async (req, res) => {
  try {
    const adjustment = await prisma.balanceAdjustment.findUnique({
      where: { id: req.params.id },
      include: { ...INCLUDE, ledgerEntries: true },
    });
    if (!adjustment)
      return res.status(404).json({ success: false, error: "Balance adjustment not found" });

    res.status(200).json({ success: true, data: adjustment });
  } catch (err) {
    // Malformed ObjectId
    if (err?.code === "P2023")
      return res.status(404).json({ success: false, error: "Balance adjustment not found" });
    handleError(res, err, "Failed to fetch balance adjustment");
  }
});

/* --------------------------------- UPDATE -------------------------------- */
// Reverses the old effect (balance + ledger entries) and applies the new one
// in a single transaction, so changing the method, bank, type or amount
// always leaves every balance and ledger consistent.
router.put("/:id", authenticate, requirePermission("BALANCE_ADJUSTMENT_EDIT"), async (req, res) => {
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.balanceAdjustment.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AdjustmentError(404, "Balance adjustment not found");

      const v = normalisePayload(req.body, existing);
      const { account: target } = await resolveTarget(tx, v);

      // Balances of every account involved, before we touch anything
      const oldAccount = await tx.account.findUnique({ where: { id: existing.accountId } });
      const initial = new Map([[existing.accountId, oldAccount.balance]]);
      if (!initial.has(target.id)) initial.set(target.id, target.balance);

      await reverseAdjustment(tx, existing);
      const snap = await applyAdjustment(tx, existing.id, target.id, v);
      if (v.type === "SUBTRACT") await assertNotOverdrawn(tx, new Map([[target.id, initial.get(target.id)]]));

      return tx.balanceAdjustment.update({
        where: { id: existing.id },
        data: {
          adjustmentDate: v.adjustmentDate,
          method: v.method,
          type: v.type,
          amount: v.amount,
          reason: v.reason,
          referenceNo: v.referenceNo,
          remarks: v.remarks,
          bankId: v.bankId,
          accountId: target.id,
          ...snap,
        },
        include: INCLUDE,
      });
    });

    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    if (err?.code === "P2023")
      return res.status(404).json({ success: false, error: "Balance adjustment not found" });
    handleError(res, err, "Failed to update balance adjustment");
  }
});

/* --------------------------------- DELETE -------------------------------- */
router.delete("/:id", authenticate, requirePermission("BALANCE_ADJUSTMENT_DELETE"), async (req, res) => {
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.balanceAdjustment.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AdjustmentError(404, "Balance adjustment not found");

      await reverseAdjustment(tx, existing);
      await tx.balanceAdjustment.delete({ where: { id: existing.id } });
    });

    res.status(200).json({ success: true, message: "Balance adjustment deleted and balance reversed" });
  } catch (err) {
    if (err?.code === "P2023")
      return res.status(404).json({ success: false, error: "Balance adjustment not found" });
    handleError(res, err, "Failed to delete balance adjustment");
  }
});

export default router;
