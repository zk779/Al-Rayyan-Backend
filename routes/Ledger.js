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
              select: { id: true, customerName: true, phone: true, email: true },
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

router.get("/", authenticate, async (req, res) => {
  try {
    const {
      accountType,
      accountTypes,
      entryType,
      entryTypes,
      vendorId,
      customerId,
      from,
      to,
      timezone, // IANA tz from the client, e.g. "Asia/Karachi" — falls back to UTC if omitted/invalid
      page = 1,
      limit = 50,
      includeDetails = "true",
      includeSummary = "true", // default ON; pass false to skip the extra scan
    } = req.query;

    const take = Math.min(100, Math.max(1, Number(limit)));
    const skip = (Number(page) - 1) * take;

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

    /* ---------- Query (paginated entries + total count + full-set totals) ---------- */
    const [rawEntries, total, summary] = await Promise.all([
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
        orderBy: { transactionDate: "desc" },
        skip,
        take,
      }),
      prisma.ledgerEntry.count({ where }),
      includeSummary !== "false" ? computeAccountTotals(where) : null,
    ]);

    /* ---------- Attach related details (one extra round-trip, batched) ---------- */
    const shouldIncludeDetails = includeDetails !== "false";
    const entries = shouldIncludeDetails
      ? await attachRelatedDetails(rawEntries)
      : rawEntries;

    /* ---------- Response ---------- */
    res.json({
      success: true,
      data: entries,
      meta: {
        page: Number(page),
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
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