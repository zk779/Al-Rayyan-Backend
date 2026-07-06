import express from "express";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

const EXPENSE_CATEGORIES = [
  "OFFICE_SUPPLIES",
  "SALARY",
  "TRAVEL",
  "MARKETING",
  "MEALS",
  "TRAINING",
];

const EXPENSE_STATUSES = ["APPROVED", "REJECTED"];
const PAYMENT_MODES = ["CASH", "BANK_TRANSFER"];

// ---- POST (CREATE) ----
router.post("/", async (req, res) => {
  try {
    let {
      date,
      expenseDate,
      category,
      branchId,
      amount,
      status,
      paymentMode,
      bankId,
      description,
    } = req.body;

    if (!expenseDate || !category || !branchId || amount === undefined || !paymentMode)
      return res.status(400).json({
        success: false,
        error: "expenseDate, category, branchId, amount and paymentMode are required",
      });

    amount = Number(amount);
    if (isNaN(amount) || amount <= 0)
      return res
        .status(400)
        .json({ success: false, error: "amount must be a number greater than 0" });

    if (!EXPENSE_CATEGORIES.includes(category))
      return res.status(400).json({
        success: false,
        error: `category must be one of: ${EXPENSE_CATEGORIES.join(", ")}`,
      });

    if (!PAYMENT_MODES.includes(paymentMode))
      return res.status(400).json({
        success: false,
        error: `paymentMode must be one of: ${PAYMENT_MODES.join(", ")}`,
      });

    const newStatus = status ?? "APPROVED";
    if (!EXPENSE_STATUSES.includes(newStatus))
      return res.status(400).json({
        success: false,
        error: `status must be one of: ${EXPENSE_STATUSES.join(", ")}`,
      });

    // ---- paymentMode / bankId consistency ----
    if (paymentMode === "BANK_TRANSFER" && !bankId)
      return res.status(400).json({
        success: false,
        error: "bankId is required when paymentMode is BANK_TRANSFER",
      });

    if (paymentMode === "CASH" && bankId)
      return res.status(400).json({
        success: false,
        error: "bankId must not be set when paymentMode is CASH",
      });

    const parsedExpenseDate = new Date(expenseDate);
    if (isNaN(parsedExpenseDate.getTime()))
      return res
        .status(400)
        .json({ success: false, error: "expenseDate must be a valid date" });

    const parsedDate = date ? new Date(date) : new Date();
    if (isNaN(parsedDate.getTime()))
      return res.status(400).json({ success: false, error: "date must be a valid date" });

    // branchId is just a reference — still validate the branch exists/active
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch)
      return res.status(404).json({ success: false, error: "Branch not found" });
    if (!branch.isActive)
      return res.status(400).json({ success: false, error: "Branch is inactive" });

    // ---- Load + validate bank (only matters if it will actually post) ----
    let bank = null;
    if (paymentMode === "BANK_TRANSFER") {
      bank = await prisma.bank.findUnique({
        where: { id: bankId },
        include: { account: true },
      });

      if (!bank)
        return res.status(404).json({ success: false, error: "Bank not found" });

      if (!bank.isActive)
        return res.status(400).json({ success: false, error: "Bank account is inactive" });

      if (newStatus === "APPROVED" && amount > bank.account.balance)
        return res.status(400).json({
          success: false,
          error: `Insufficient bank balance. Trying to pay ${amount} but bank only has ${bank.account.balance} available.`,
        });
    }

    const result = await prisma.$transaction(async (tx) => {
      const expense = await tx.expense.create({
        data: {
          date: parsedDate,
          expenseDate: parsedExpenseDate,
          category,
          branchId, // plain reference, no Account involved
          amount,
          status: newStatus,
          paymentMode,
          bankId: paymentMode === "BANK_TRANSFER" ? bankId : null,
          description: description ?? null,
        },
      });

      // Only APPROVED + BANK_TRANSFER expenses ever touch an account/ledger.
      if (newStatus === "APPROVED" && paymentMode === "BANK_TRANSFER") {
        await tx.account.update({
          where: { id: bank.account.id },
          data: { balance: { increment: -amount } },
        });

        await tx.ledgerEntry.create({
          data: {
            accountId: bank.account.id,
            entryType: "EXPENSE",
            debit: 0,
            credit: amount,
            expenseId: expense.id,
            transactionDate: parsedExpenseDate,
            remarks: description ?? null,
          },
        });
      }

      return expense;
    });

    const fullExpense = await prisma.expense.findUnique({
      where: { id: result.id },
      include: {
        branch: { select: { id: true, name: true, code: true } },
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        ledgerEntries: true,
      },
    });

    res.status(201).json({ success: true, data: fullExpense });
  } catch (err) {
    console.error("Error creating expense:", err);
    res.status(500).json({ success: false, error: "Failed to create expense" });
  }
});

// ---- GET ALL ----
// Optional query filters: ?branchId=&category=&status=&paymentMode=
router.get("/", async (req, res) => {
  try {
    const { branchId, category, status, paymentMode } = req.query;

    const where = {};
    if (branchId) where.branchId = branchId;
    if (category) where.category = category;
    if (status) where.status = status;
    if (paymentMode) where.paymentMode = paymentMode;

    const expenses = await prisma.expense.findMany({
      where,
      include: {
        branch: { select: { id: true, name: true, code: true } },
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        ledgerEntries: true,
      },
      orderBy: { expenseDate: "desc" },
    });

    res.status(200).json({ success: true, data: expenses });
  } catch (err) {
    console.error("Error fetching expenses:", err);
    res.status(500).json({ success: false, error: "Failed to fetch expenses" });
  }
});

// ---- GET BY ID ----
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const expense = await prisma.expense.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, name: true, code: true } },
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        ledgerEntries: true,
      },
    });

    if (!expense)
      return res.status(404).json({ success: false, error: "Expense not found" });

    res.status(200).json({ success: true, data: expense });
  } catch (err) {
    console.error("Error fetching expense:", err);
    res.status(500).json({ success: false, error: "Failed to fetch expense" });
  }
});

// ---- GET BRANCH TOTALS ----
// Aggregate report: total expense amount per branch (optionally filtered).
// This replaces the old "running balance account" — totals are computed
// on demand instead of tracked as a persisted balance.
router.get("/reports/by-branch", async (req, res) => {
  try {
    const { status, category } = req.query;

    const where = {};
    if (status) where.status = status;
    if (category) where.category = category;

    const grouped = await prisma.expense.groupBy({
      by: ["branchId"],
      where,
      _sum: { amount: true },
      _count: { _all: true },
    });

    const branchIds = grouped.map((g) => g.branchId);
    const branchList = await prisma.branch.findMany({
      where: { id: { in: branchIds } },
      select: { id: true, name: true, code: true },
    });
    const branchMap = Object.fromEntries(branchList.map((b) => [b.id, b]));

    const data = grouped.map((g) => ({
      branch: branchMap[g.branchId] ?? { id: g.branchId },
      totalAmount: g._sum.amount ?? 0,
      count: g._count._all,
    }));

    res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("Error fetching branch expense totals:", err);
    res.status(500).json({ success: false, error: "Failed to fetch branch expense totals" });
  }
});

// ---- PUT (UPDATE) ----
// Every transition (amount change, category/branch change, status flip,
// CASH<->BANK_TRANSFER switch, bank switch) is handled by fully reversing
// whatever the OLD state posted to the bank (if anything) and fully
// re-applying whatever the NEW state should post (if anything).
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      date,
      expenseDate,
      category,
      branchId,
      amount,
      status,
      paymentMode,
      bankId,
      description,
    } = req.body;

    const existing = await prisma.expense.findUnique({
      where: { id },
      include: { ledgerEntries: true },
    });

    if (!existing)
      return res.status(404).json({ success: false, error: "Expense not found" });

    // ---- Validate editable fields ----
    if (amount !== undefined) {
      const n = Number(amount);
      if (isNaN(n) || n <= 0)
        return res
          .status(400)
          .json({ success: false, error: "amount must be a number greater than 0" });
    }

    if (category !== undefined && !EXPENSE_CATEGORIES.includes(category))
      return res.status(400).json({
        success: false,
        error: `category must be one of: ${EXPENSE_CATEGORIES.join(", ")}`,
      });

    if (status !== undefined && !EXPENSE_STATUSES.includes(status))
      return res.status(400).json({
        success: false,
        error: `status must be one of: ${EXPENSE_STATUSES.join(", ")}`,
      });

    if (paymentMode !== undefined && !PAYMENT_MODES.includes(paymentMode))
      return res.status(400).json({
        success: false,
        error: `paymentMode must be one of: ${PAYMENT_MODES.join(", ")}`,
      });

    if (expenseDate !== undefined) {
      const p = new Date(expenseDate);
      if (isNaN(p.getTime()))
        return res
          .status(400)
          .json({ success: false, error: "expenseDate must be a valid date" });
    }

    if (date !== undefined) {
      const p = new Date(date);
      if (isNaN(p.getTime()))
        return res.status(400).json({ success: false, error: "date must be a valid date" });
    }

    const newAmount = amount !== undefined ? Number(amount) : existing.amount;
    const newCategory = category ?? existing.category;
    const newBranchId = branchId ?? existing.branchId;
    const newStatus = status ?? existing.status;
    const newPaymentMode = paymentMode ?? existing.paymentMode;
    const newBankId = bankId !== undefined ? bankId : existing.bankId;
    const newDescription = description !== undefined ? description : existing.description;
    const newExpenseDate = expenseDate ? new Date(expenseDate) : existing.expenseDate;
    const newDate = date ? new Date(date) : existing.date;

    // ---- paymentMode / bankId consistency ----
    if (newPaymentMode === "BANK_TRANSFER" && !newBankId)
      return res.status(400).json({
        success: false,
        error: "bankId is required when paymentMode is BANK_TRANSFER",
      });

    if (newPaymentMode === "CASH" && newBankId)
      return res.status(400).json({
        success: false,
        error: "bankId must not be set when paymentMode is CASH",
      });

    const wasApproved = existing.status === "APPROVED";
    const willBeApproved = newStatus === "APPROVED";

    // Branch is just a reference — validate it exists/active if it changed
    if (newBranchId !== existing.branchId) {
      const newBranch = await prisma.branch.findUnique({ where: { id: newBranchId } });
      if (!newBranch)
        return res.status(404).json({ success: false, error: "Branch not found" });
      if (!newBranch.isActive)
        return res.status(400).json({ success: false, error: "Branch is inactive" });
    }

    // ---- Load OLD bank (needed to reverse its leg, if any) ----
    let oldBank = null;
    if (wasApproved && existing.paymentMode === "BANK_TRANSFER" && existing.bankId) {
      oldBank = await prisma.bank.findUnique({
        where: { id: existing.bankId },
        include: { account: true },
      });
    }

    // ---- Load + validate NEW bank (needed if the new state posts a bank leg) ----
    let newBank = null;
    if (willBeApproved && newPaymentMode === "BANK_TRANSFER") {
      newBank = await prisma.bank.findUnique({
        where: { id: newBankId },
        include: { account: true },
      });

      if (!newBank)
        return res.status(404).json({ success: false, error: "Bank not found" });

      if (!newBank.isActive)
        return res.status(400).json({ success: false, error: "Bank account is inactive" });

      // Sufficiency check — if it's the same bank as before (and it was already
      // posting), restore its old debit first before comparing.
      const restoredBankBalance =
        oldBank?.id === newBank.id
          ? newBank.account.balance + existing.amount
          : newBank.account.balance;

      if (newAmount > restoredBankBalance)
        return res.status(400).json({
          success: false,
          error: `Insufficient bank balance. Trying to pay ${newAmount} but bank only has ${restoredBankBalance} available.`,
        });
    }

    const result = await prisma.$transaction(async (tx) => {
      // ---- 1. Reverse the OLD bank leg, if any ----
      if (oldBank) {
        await tx.account.update({
          where: { id: oldBank.account.id },
          data: { balance: { increment: existing.amount } }, // undo the old -amount debit
        });
      }

      // Old ledger entries are always cleared (there's at most one, and only
      // if the old state was APPROVED + BANK_TRANSFER); recreated below only
      // if the new state needs one.
      await tx.ledgerEntry.deleteMany({ where: { expenseId: id } });

      // ---- 2. Update the expense record ----
      const updated = await tx.expense.update({
        where: { id },
        data: {
          date: newDate,
          expenseDate: newExpenseDate,
          category: newCategory,
          branchId: newBranchId,
          amount: newAmount,
          status: newStatus,
          paymentMode: newPaymentMode,
          bankId: newPaymentMode === "BANK_TRANSFER" ? newBankId : null,
          description: newDescription,
        },
      });

      // ---- 3. Apply the NEW bank leg, if needed ----
      if (willBeApproved && newPaymentMode === "BANK_TRANSFER" && newBank) {
        await tx.account.update({
          where: { id: newBank.account.id },
          data: { balance: { increment: -newAmount } },
        });

        await tx.ledgerEntry.create({
          data: {
            accountId: newBank.account.id,
            entryType: "EXPENSE",
            debit: 0,
            credit: newAmount,
            expenseId: id,
            transactionDate: newExpenseDate,
            remarks: newDescription ?? null,
          },
        });
      }

      return updated;
    });

    const fullExpense = await prisma.expense.findUnique({
      where: { id: result.id },
      include: {
        branch: { select: { id: true, name: true, code: true } },
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        ledgerEntries: true,
      },
    });

    res.status(200).json({ success: true, data: fullExpense });
  } catch (err) {
    console.error("Error updating expense:", err);
    res.status(500).json({ success: false, error: "Failed to update expense" });
  }
});

// ---- DELETE ----
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.expense.findUnique({
      where: { id },
      include: { ledgerEntries: true },
    });

    if (!existing)
      return res.status(404).json({ success: false, error: "Expense not found" });

    let bank = null;
    if (existing.status === "APPROVED" && existing.paymentMode === "BANK_TRANSFER" && existing.bankId) {
      bank = await prisma.bank.findUnique({
        where: { id: existing.bankId },
        include: { account: true },
      });
    }

    await prisma.$transaction(async (tx) => {
      // Reverse the bank leg, if any (this is the ONLY balance ever affected)
      if (bank) {
        await tx.account.update({
          where: { id: bank.account.id },
          data: { balance: { increment: existing.amount } },
        });
      }

      await tx.ledgerEntry.deleteMany({ where: { expenseId: id } });
      await tx.expense.delete({ where: { id } });
    });

    res.status(200).json({ success: true, message: "Expense deleted successfully" });
  } catch (err) {
    console.error("Error deleting expense:", err);
    res.status(500).json({ success: false, error: "Failed to delete expense" });
  }
});

export default router;