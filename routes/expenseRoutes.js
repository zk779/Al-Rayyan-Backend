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
      userId,
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

    // ---- category / userId consistency (SALARY requires an employee) ----
    if (category === "SALARY" && !userId)
      return res.status(400).json({
        success: false,
        error: "userId is required when category is SALARY",
      });

    if (category !== "SALARY" && userId)
      return res.status(400).json({
        success: false,
        error: "userId must not be set when category is not SALARY",
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

    // ---- Validate user (only required/relevant when category is SALARY) ----
    if (category === "SALARY") {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user)
        return res.status(404).json({ success: false, error: "User not found" });
      if (!user.isActive)
        return res.status(400).json({ success: false, error: "User is inactive" });
    }

    // ---- Load + validate bank (BANK_TRANSFER only) ----
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

    // ---- Load cash account (CASH only) — validation, not creation ----
    let cashAccount = null;
    if (paymentMode === "CASH") {
      cashAccount = await prisma.account.findFirst({ where: { type: "CASH" } });

      if (newStatus === "APPROVED" && cashAccount && amount > cashAccount.balance)
        return res.status(400).json({
          success: false,
          error: `Insufficient cash balance. Trying to pay ${amount} but cash account only has ${cashAccount.balance} available.`,
        });
    }

    const result = await prisma.$transaction(async (tx) => {
      // ---- Get-or-create the singleton EXPENSE account ----
      const getExpenseAccount = async () => {
        let expenseAccount = await tx.account.findFirst({ where: { type: "EXPENSE" } });

        if (!expenseAccount) {
          expenseAccount = await tx.account.create({
            data: { name: "Expense Account", type: "EXPENSE", balance: 0 },
          });
        }

        return expenseAccount;
      };

      // ---- Get-or-create the singleton CASH account (only if needed) ----
      const getCashAccount = async () => {
        if (cashAccount) return cashAccount;

        cashAccount = await tx.account.findFirst({ where: { type: "CASH" } });

        if (!cashAccount) {
          cashAccount = await tx.account.create({
            data: { name: "Cash Account", type: "CASH", balance: 0 },
          });
        }

        return cashAccount;
      };

      const cash = paymentMode === "CASH" ? await getCashAccount() : null;

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
          accountId: paymentMode === "CASH" ? cash.id : null,
          userId: category === "SALARY" ? userId : null,
          description: description ?? null,
        },
      });

      if (newStatus === "APPROVED") {
        // ── 1. Always post a debit entry against the Expense account, and
        //       grow its balance — this tracks total expenses regardless
        //       of payment mode.
        const expenseAccount = await getExpenseAccount();

        await tx.ledgerEntry.create({
          data: {
            accountId: expenseAccount.id,
            entryType: "EXPENSE",
            debit: amount,
            credit: 0,
            expenseId: expense.id,
            transactionDate: parsedExpenseDate,
            remarks: description ?? null,
          },
        });

        await tx.account.update({
          where: { id: expenseAccount.id },
          data: { balance: { increment: amount } },
        });

        // ── 2. Deduct from wherever the money actually came from ──
        if (paymentMode === "BANK_TRANSFER") {
          await tx.account.update({
            where: { id: bank.account.id },
            data: { balance: { increment: -amount } },
          });

          await tx.ledgerEntry.create({
            data: {
              accountId: bank.account.id,
              entryType: "EXPENSE",
              debit: amount,
              credit: 0,
              expenseId: expense.id,
              transactionDate: parsedExpenseDate,
              remarks: description ?? null,
            },
          });
        } else if (paymentMode === "CASH") {
          await tx.account.update({
            where: { id: cash.id },
            data: { balance: { increment: -amount } },
          });

          await tx.ledgerEntry.create({
            data: {
              accountId: cash.id,
              entryType: "EXPENSE",
              debit: amount,
              credit: 0,
              expenseId: expense.id,
              transactionDate: parsedExpenseDate,
              remarks: description ?? null,
            },
          });
        }
      }

      return expense;
    });

    const fullExpense = await prisma.expense.findUnique({
      where: { id: result.id },
      include: {
        branch: { select: { id: true, name: true, code: true } },
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        account: { select: { id: true, name: true, type: true, balance: true } },
        user: { select: { id: true, fullName: true, email: true } },
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
// Optional query filters: ?branchId=&category=&status=&paymentMode=&userId=
router.get("/", async (req, res) => {
  try {
    const { branchId, category, status, paymentMode, userId } = req.query;

    const where = {};
    if (branchId) where.branchId = branchId;
    if (category) where.category = category;
    if (status) where.status = status;
    if (paymentMode) where.paymentMode = paymentMode;
    if (userId) where.userId = userId;

    const expenses = await prisma.expense.findMany({
      where,
      include: {
        branch: { select: { id: true, name: true, code: true } },
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        account: { select: { id: true, name: true, type: true, balance: true } },
        user: { select: { id: true, fullName: true, email: true } },
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
        account: { select: { id: true, name: true, type: true, balance: true } },
        user: { select: { id: true, fullName: true, email: true } },
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
// CASH<->BANK_TRANSFER switch, bank switch, userId switch) fully reverses
// whatever the OLD state posted and fully re-applies whatever the NEW state
// should post. Ledger entries get recreated for both CASH and BANK_TRANSFER;
// account BALANCE and accountId are only ever touched for BANK_TRANSFER —
// CASH's ledger entry always has accountId: null.
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
      userId,
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
    const newUserId = userId !== undefined ? userId : existing.userId;
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

    // ---- category / userId consistency (SALARY requires an employee) ----
    if (newCategory === "SALARY" && !newUserId)
      return res.status(400).json({
        success: false,
        error: "userId is required when category is SALARY",
      });

    if (newCategory !== "SALARY" && newUserId)
      return res.status(400).json({
        success: false,
        error: "userId must not be set when category is not SALARY",
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

    // ---- Validate user if it changed (only relevant when category is SALARY) ----
    if (newCategory === "SALARY" && newUserId !== existing.userId) {
      const user = await prisma.user.findUnique({ where: { id: newUserId } });
      if (!user)
        return res.status(404).json({ success: false, error: "User not found" });
      if (!user.isActive)
        return res.status(400).json({ success: false, error: "User is inactive" });
    }

    // ---- Load OLD bank (only needed to reverse a BANK_TRANSFER balance leg) ----
    let oldBank = null;
    if (wasApproved && existing.paymentMode === "BANK_TRANSFER" && existing.bankId) {
      oldBank = await prisma.bank.findUnique({
        where: { id: existing.bankId },
        include: { account: true },
      });
    }

    // ---- Load OLD cash account (only needed to reverse a CASH balance leg) ----
    let oldCashAccount = null;
    if (wasApproved && existing.paymentMode === "CASH" && existing.accountId) {
      oldCashAccount = await prisma.account.findUnique({ where: { id: existing.accountId } });
    }

    // ---- Load + validate NEW bank (needed if the new state posts a BANK_TRANSFER leg) ----
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

      // Sufficiency check. If it's the same bank as before (and it was already
      // posting), restore its old debit first.
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

    // ---- Load + validate NEW cash account (needed if the new state posts a CASH leg) ----
    let newCashAccount = null;
    if (willBeApproved && newPaymentMode === "CASH") {
      newCashAccount = await prisma.account.findFirst({ where: { type: "CASH" } });

      if (newCashAccount) {
        const restoredCashBalance =
          oldCashAccount?.id === newCashAccount.id
            ? newCashAccount.balance + existing.amount
            : newCashAccount.balance;

        if (newAmount > restoredCashBalance)
          return res.status(400).json({
            success: false,
            error: `Insufficient cash balance. Trying to pay ${newAmount} but cash account only has ${restoredCashBalance} available.`,
          });
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      // ---- Get-or-create the singleton EXPENSE account ----
      const getExpenseAccount = async () => {
        let expenseAccount = await tx.account.findFirst({ where: { type: "EXPENSE" } });

        if (!expenseAccount) {
          expenseAccount = await tx.account.create({
            data: { name: "Expense Account", type: "EXPENSE", balance: 0 },
          });
        }

        return expenseAccount;
      };

      // ---- Get-or-create the singleton CASH account (only if needed) ----
      const getCashAccount = async () => {
        if (newCashAccount) return newCashAccount;

        newCashAccount = await tx.account.findFirst({ where: { type: "CASH" } });

        if (!newCashAccount) {
          newCashAccount = await tx.account.create({
            data: { name: "Cash Account", type: "CASH", balance: 0 },
          });
        }

        return newCashAccount;
      };

      const expenseAccount = await getExpenseAccount();
      const cash = willBeApproved && newPaymentMode === "CASH" ? await getCashAccount() : null;

      // ---- 1. Reverse the OLD legs (if the old expense was APPROVED) ----

      // 1a. Expense-account leg — always reversed if it was previously approved
      if (wasApproved) {
        await tx.account.update({
          where: { id: expenseAccount.id },
          data: { balance: { increment: -existing.amount } }, // undo the old +amount growth
        });
      }

      // 1b. Bank leg — BANK_TRANSFER only
      if (wasApproved && existing.paymentMode === "BANK_TRANSFER" && oldBank) {
        await tx.account.update({
          where: { id: oldBank.account.id },
          data: { balance: { increment: existing.amount } }, // undo the old -amount debit
        });
      }

      // 1c. Cash leg — CASH only
      if (wasApproved && existing.paymentMode === "CASH" && oldCashAccount) {
        await tx.account.update({
          where: { id: oldCashAccount.id },
          data: { balance: { increment: existing.amount } }, // undo the old -amount debit
        });
      }

      // Old ledger entries are always cleared; recreated below if the new
      // state needs them.
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
          accountId: newPaymentMode === "CASH" ? cash?.id ?? null : null,
          userId: newCategory === "SALARY" ? newUserId : null,
          description: newDescription,
        },
      });

      // ---- 3. Apply the NEW legs (only if the new state is APPROVED) ----
      if (willBeApproved) {
        // 3a. Expense-account leg — always posted regardless of payment mode
        await tx.ledgerEntry.create({
          data: {
            accountId: expenseAccount.id,
            entryType: "EXPENSE",
            debit: newAmount,
            credit: 0,
            expenseId: id,
            transactionDate: newExpenseDate,
            remarks: newDescription ?? null,
          },
        });

        await tx.account.update({
          where: { id: expenseAccount.id },
          data: { balance: { increment: newAmount } },
        });

        // 3b. Source-account leg
        if (newPaymentMode === "BANK_TRANSFER") {
          await tx.account.update({
            where: { id: newBank.account.id },
            data: { balance: { increment: -newAmount } },
          });

          await tx.ledgerEntry.create({
            data: {
              accountId: newBank.account.id,
              entryType: "EXPENSE",
              debit: newAmount,
              credit: 0,
              expenseId: id,
              transactionDate: newExpenseDate,
              remarks: newDescription ?? null,
            },
          });
        } else if (newPaymentMode === "CASH") {
          await tx.account.update({
            where: { id: cash.id },
            data: { balance: { increment: -newAmount } },
          });

          await tx.ledgerEntry.create({
            data: {
              accountId: cash.id,
              entryType: "EXPENSE",
              debit: newAmount,
              credit: 0,
              expenseId: id,
              transactionDate: newExpenseDate,
              remarks: newDescription ?? null,
            },
          });
        }
      }

      return updated;
    });

    const fullExpense = await prisma.expense.findUnique({
      where: { id: result.id },
      include: {
        branch: { select: { id: true, name: true, code: true } },
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        account: { select: { id: true, name: true, type: true, balance: true } },
        user: { select: { id: true, fullName: true, email: true } },
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

    // Nothing to reverse at all unless the expense was actually APPROVED —
    // REJECTED expenses never touched any account/ledger.
    const wasApproved = existing.status === "APPROVED";

    // ---- Load the Expense account (always involved when wasApproved) ----
    let expenseAccount = null;
    if (wasApproved) {
      expenseAccount = await prisma.account.findFirst({ where: { type: "EXPENSE" } });
    }

    // ---- Load bank (only needed to reverse a BANK_TRANSFER leg) ----
    let bank = null;
    if (wasApproved && existing.paymentMode === "BANK_TRANSFER" && existing.bankId) {
      bank = await prisma.bank.findUnique({
        where: { id: existing.bankId },
        include: { account: true },
      });
    }

    // ---- Load cash account (only needed to reverse a CASH leg) ----
    let cashAccount = null;
    if (wasApproved && existing.paymentMode === "CASH" && existing.accountId) {
      cashAccount = await prisma.account.findUnique({ where: { id: existing.accountId } });
    }

    await prisma.$transaction(async (tx) => {
      // ---- 1. Reverse the Expense-account leg (grows on approve, shrinks on delete) ----
      if (wasApproved && expenseAccount) {
        await tx.account.update({
          where: { id: expenseAccount.id },
          data: { balance: { increment: -existing.amount } },
        });
      }

      // ---- 2. Reverse the source-account leg (bank OR cash — whichever was used) ----
      if (wasApproved && existing.paymentMode === "BANK_TRANSFER" && bank) {
        await tx.account.update({
          where: { id: bank.account.id },
          data: { balance: { increment: existing.amount } }, // undo the -amount debit
        });
      }

      if (wasApproved && existing.paymentMode === "CASH" && cashAccount) {
        await tx.account.update({
          where: { id: cashAccount.id },
          data: { balance: { increment: existing.amount } }, // undo the -amount debit
        });
      }

      // ---- 3. Delete all ledger entries tied to this expense ----
      await tx.ledgerEntry.deleteMany({ where: { expenseId: id } });

      // ---- 4. Delete the expense record itself ----
      await tx.expense.delete({ where: { id } });
    });

    res.status(200).json({ success: true, message: "Expense deleted successfully" });
  } catch (err) {
    console.error("Error deleting expense:", err);
    res.status(500).json({ success: false, error: "Failed to delete expense" });
  }
});

export default router;