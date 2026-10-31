import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { localDayRangeToUtc } from "../utils/dateRange.js"; // adjust path to wherever you saved this helper

const router = express.Router();
const prisma = new PrismaClient();

/* =========================== 🔐 AUTH =========================== */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res
      .status(401)
      .json({ success: false, error: "Missing Authorization header" });

  try {
    const token = authHeader.split(" ")[1];
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res
      .status(401)
      .json({ success: false, error: "Invalid or expired token" });
  }
}

/* ===============================================================
   HELPERS — fetch related detail records by ID sets
   =============================================================== */

/**
 * Given a list of ledger entries, collect all non-null reference IDs
 * of each type, batch-fetch the records, then stitch them back.
 */
async function attachRelatedDetails(entries) {
  // ── 1. Collect IDs ──────────────────────────────────────────
  const saleIds     = [...new Set(entries.map(e => e.saleId).filter(Boolean))];
  const invoiceIds  = [...new Set(entries.map(e => e.invoiceId).filter(Boolean))];
  const paymentIds  = [...new Set(entries.map(e => e.paymentId).filter(Boolean))];
  const refundIds   = [...new Set(entries.map(e => e.refundId).filter(Boolean))];
  // Note: expenseId is stored but there is no Expense model in the current
  // schema — we surface the raw id; add a lookup here once the model exists.

  // ── 2. Batch-fetch in parallel ───────────────────────────────
  const [sales, invoices, payments, refunds] = await Promise.all([
    saleIds.length
      ? prisma.sale.findMany({
          where: { id: { in: saleIds } },
          select: {
            id: true,
            pnr: true,
            documentNo: true,
            routeType: true,
            tripType: true,
            departureDate: true,
            saleType: true,
            checkInDate: true,
            checkOutDate: true,
            hotelName: true,
            returnDate: true,
            paxName: true,
            destinations: true,
            netPrice: true,
            sellPrice: true,
            profit: true,
            vatAmount: true,
            paxVat: true,
            miscCharges: true,
            paymentType: true,
            paymentStatus: true,
            paidAmount: true,
            status: true,
            remarks: true,
            createdAt: true,
            invoice: {
              select: { invoiceNo: true, saleDate: true },
            },
            airline: {
              select: { airlineName: true, iataName: true, airlineCode: true },
            },
            vendor: {
              select: { id: true, vendorName: true, category: true },
            },
            customer: {
              select: { id: true, customerName: true, phone: true, email: true, customerType: true },
            },
            bank: {
              select: { id: true, bankName: true, accountNumber: true },
            },
          },
        })
      : [],

    invoiceIds.length
      ? prisma.salesInvoice.findMany({
          where: { id: { in: invoiceIds } },
          select: {
            id: true,
            invoiceNo: true,
            saleDate: true,
            totalNet: true,
            totalSell: true,
            totalProfit: true,
            user: { select: { id: true, fullName: true, email: true } },
          },
        })
      : [],

    paymentIds.length
      ? prisma.salePayment.findMany({
          where: { id: { in: paymentIds } },
          select: {
            id: true,
            method: true,
            amount: true,
            paymentDate: true,
            remarks: true,
            bank: {
              select: { id: true, bankName: true, accountNumber: true },
            },
            posCardType: true,
            posCommissionRate: true,
            pos: {
              select: {
                id: true,
                terminalId: true,
                providerName: true,
                bank: { select: { id: true, bankName: true, accountNumber: true } },
              },
            },
            customer: {
              select: { id: true, customerName: true, phone: true },
            },
            sale: {
              select: {
                id: true,
                pnr: true,
                documentNo: true,
                paxName: true,
                invoice: { select: { invoiceNo: true } },
              },
            },
          },
        })
      : [],

    refundIds.length
      ? prisma.refund.findMany({
          where: { id: { in: refundIds } },
          select: {
            id: true,
            originalSaleAmount: true,
            customerRefundAmount: true,
            vendorRefundAmount: true,
            refundFee: true,
            cancellationCharges: true,
            netRefundToCustomer: true,
            netCostToUs: true,
            refundReason: true,
            remarks: true,
            status: true,
            refundDate: true,
            approvedAt: true,
            completedAt: true,
            processedBy: {
              select: { id: true, fullName: true },
            },
            sale: {
              select: {
                id: true,
                pnr: true,
                documentNo: true,
                paxName: true,
                sellPrice: true,
                customer: {
                  select: { id: true, customerName: true, phone: true },
                },
                invoice: { select: { invoiceNo: true } },
              },
            },
          },
        })
      : [],
  ]);

  // ── 3. Build lookup maps ─────────────────────────────────────
  const saleMap    = Object.fromEntries(sales.map(s => [s.id, s]));
  const invoiceMap = Object.fromEntries(invoices.map(i => [i.id, i]));
  const paymentMap = Object.fromEntries(payments.map(p => [p.id, p]));
  const refundMap  = Object.fromEntries(refunds.map(r => [r.id, r]));

  // ── 4. Stitch back onto each entry ───────────────────────────
  return entries.map(entry => ({
    ...entry,
    details: {
      sale:    entry.saleId    ? (saleMap[entry.saleId]       ?? null) : null,
      invoice: entry.invoiceId ? (invoiceMap[entry.invoiceId] ?? null) : null,
      payment: entry.paymentId ? (paymentMap[entry.paymentId] ?? null) : null,
      refund:  entry.refundId  ? (refundMap[entry.refundId]   ?? null) : null,
      expenseId: entry.expenseId ?? null,
    },
  }));
}

async function computeAccountTotals(where) {
  const rows = await prisma.ledgerEntry.findMany({
    where,
    select: { accountId: true, debit: true, credit: true },
  });

  const byAccountMap = new Map();
  let overallDebit = 0;
  let overallCredit = 0;

  for (const row of rows) {
    overallDebit += row.debit ?? 0;
    overallCredit += row.credit ?? 0;

    if (!row.accountId) continue; // entries with no linked account are excluded from the breakdown

    const bucket = byAccountMap.get(row.accountId) ?? {
      accountId: row.accountId,
      totalDebit: 0,
      totalCredit: 0,
      entryCount: 0,
    };
    bucket.totalDebit += row.debit ?? 0;
    bucket.totalCredit += row.credit ?? 0;
    bucket.entryCount += 1;
    byAccountMap.set(row.accountId, bucket);
  }

  const accountIds = [...byAccountMap.keys()];

  const accounts = accountIds.length
    ? await prisma.account.findMany({
        where: { id: { in: accountIds } },
        select: {
          id: true,
          name: true,
          type: true,
          referenceId: true,
          balance: true,
        },
      })
    : [];

  const accountMeta = Object.fromEntries(accounts.map(a => [a.id, a]));

  const byAccount = accountIds.map(accountId => {
    const bucket = byAccountMap.get(accountId);
    const meta = accountMeta[accountId] ?? null;
    return {
      accountId,
      name: meta?.name ?? null,
      type: meta?.type ?? null,
      referenceId: meta?.referenceId ?? null,
      currentBalance: meta?.balance ?? null,
      totalDebit: bucket.totalDebit,
      totalCredit: bucket.totalCredit,
      netMovement: bucket.totalDebit - bucket.totalCredit,
      entryCount: bucket.entryCount,
    };
  });

  // Sort so the largest-activity accounts show up first
  byAccount.sort((a, b) => (b.totalDebit + b.totalCredit) - (a.totalDebit + a.totalCredit));

  return {
    overall: {
      totalDebit: overallDebit,
      totalCredit: overallCredit,
      netMovement: overallDebit - overallCredit,
      entryCount: rows.length,
    },
    byAccount,
  };
}

const roundMoney = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// How one entry moves the account's balance, by account type:
//   CASH / BANK / VENDOR (and anything else) -> credit raises it, debit lowers it
//   CUSTOMER (receivable) / EXPENSE          -> debit raises it, credit lowers it
// One exception: a VENDOR's OPENING_BALANCE always raises the balance. Debit-
// category vendors store their opening as a debit, yet the account starts at
// +opening (see routes/vendors.js), so reading it as "debit lowers" put the
// whole running balance off by twice the opening amount.
const balanceDelta = (type, e) => {
  if (type === "VENDOR" && e.entryType === "OPENING_BALANCE") {
    return (e.credit || 0) + (e.debit || 0);
  }
  return type === "CUSTOMER" || type === "EXPENSE"
    ? (e.debit || 0) - (e.credit || 0)
    : (e.credit || 0) - (e.debit || 0);
};

// Adds `balanceAfter` to each entry: the account's remaining balance right after
// that entry. Always computed over the account's FULL history, never just the
// filtered/paged rows, so a date or entry-type filter doesn't change the numbers.
//
// It is a true running total of the account's own entries, oldest to newest, so
// every row can be verified by adding up the entries above it. If the account's
// stored balance (Account.balance) disagrees with that total, the account is
// returned in `drift` with both figures so the UI can flag the discrepancy
// instead of silently shifting every row.
async function attachRunningBalances(entries) {
  if (!entries.length) return { entries, drift: [] };

  const accounts = new Map();
  for (const e of entries) {
    if (e.account && !accounts.has(e.accountId)) accounts.set(e.accountId, e.account);
  }

  const history = await prisma.ledgerEntry.findMany({
    where: { accountId: { in: [...accounts.keys()] } },
    select: { id: true, accountId: true, debit: true, credit: true, entryType: true },
    // Same chronological order the list uses (reversed), so ties line up
    orderBy: [{ transactionDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  const byAccount = new Map();
  for (const h of history) {
    if (!byAccount.has(h.accountId)) byAccount.set(h.accountId, []);
    byAccount.get(h.accountId).push(h);
  }

  const balanceAfter = new Map();
  const drift = [];
  for (const [accountId, list] of byAccount) {
    const acc = accounts.get(accountId);
    let running = 0;
    for (const entry of list) {
      running = roundMoney(running + balanceDelta(acc.type, entry));
      balanceAfter.set(entry.id, running);
    }
    const stored = roundMoney(Number(acc.balance) || 0);
    if (Math.abs(stored - running) > 0.01) {
      drift.push({
        accountId,
        name: acc.name,
        type: acc.type,
        ledgerBalance: running,
        storedBalance: stored,
        difference: roundMoney(stored - running),
      });
    }
  }

  return {
    entries: entries.map((e) => ({ ...e, balanceAfter: balanceAfter.get(e.id) ?? null })),
    drift,
  };
}

router.get("/", authenticate, async (req, res) => {
  try {
    const {
      accountType,
      accountTypes,
      entryType,
      entryTypes,
      vendorId,
      customerId,
      bankId,
      from,
      to,
      timezone, // IANA tz from the client, e.g. "Asia/Karachi" — falls back to UTC if omitted/invalid
      includeDetails = "true",
      includeSummary = "true", // default ON; pass false to skip the extra scan
    } = req.query;

    /* ---------- Account Type Filter ---------- */
    let accountTypeFilter;
    if (accountTypes) {
      accountTypeFilter = accountTypes.split(",");
    } else if (accountType) {
      accountTypeFilter = [accountType];
    }

    /* ---------- Entry Type Filter ---------- */
    // Supports either ?entryTypes=SALE,PAYMENT or ?entryType=SALE,PAYMENT
    // (comma-separated), or a single ?entryType=SALE. Whichever param is
    // present, split on commas and drop any empty segments.
    let entryTypeFilter;
    const rawEntryTypeParam = entryTypes ?? entryType;
    if (rawEntryTypeParam) {
      entryTypeFilter = rawEntryTypeParam
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (entryTypeFilter.length === 0) entryTypeFilter = undefined;
    }

    /* ---------- Reference Filter ---------- */
    let referenceId;
    if (vendorId)   referenceId = vendorId;
    if (customerId) referenceId = customerId;
    // A bank's ledger account has referenceId = the bank's id (like vendors/customers)
    if (bankId)     referenceId = bankId;
    let transactionDateFilter;
    if (from || to) {
      transactionDateFilter = {};

      if (from) {
        const fromRange = localDayRangeToUtc(from, timezone);
        if (fromRange) transactionDateFilter.gte = fromRange.start;
      }

      if (to) {
        const toRange = localDayRangeToUtc(to, timezone);
        if (toRange) transactionDateFilter.lte = toRange.end;
      }
    }
    const where = {
      ...(entryTypeFilter && { entryType: { in: entryTypeFilter } }),
      ...(transactionDateFilter && { transactionDate: transactionDateFilter }),
      account: {
        ...(accountTypeFilter && { type: { in: accountTypeFilter } }),
        ...(referenceId && { referenceId }),
      },
    };

    /* ---------- Query (whole filtered set + full-set totals) ----------
       No skip/take — every matching entry is returned in one go and
       paginated client-side (by page size only, no re-request per page),
       same approach as GET /api/sales and GET /api/refunds. ---------- */
    const [rawEntries, summary] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where,
        include: {
          account: {
            select: {
              id: true,
              name: true,
              type: true,
              referenceId: true,
              balance: true,
            },
          },
        },
        // createdAt breaks ties between same-day entries so the order (and the
        // running balance that follows it) is deterministic
        orderBy: [{ transactionDate: "desc" }, { createdAt: "desc" }],
      }),
      includeSummary !== "false" ? computeAccountTotals(where) : null,
    ]);

    /* ---------- Running balance (remaining balance after each entry) ---------- */
    const { entries: entriesWithBalance, drift } = await attachRunningBalances(rawEntries);

    /* ---------- Attach related details (one extra round-trip, batched) ---------- */
    const shouldIncludeDetails = includeDetails !== "false";
    const entries = shouldIncludeDetails
      ? await attachRelatedDetails(entriesWithBalance)
      : entriesWithBalance;

    /* ---------- Response ---------- */
    res.json({
      success: true,
      data: entries,
      meta: {
        total: entries.length,
        balanceDrift: drift, // accounts whose stored balance != sum of their entries
      },
      ...(summary && { summary }), // omitted entirely when includeSummary=false
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch ledger entries",
    });
  }
});

export default router;