import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

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
            // Nested relations useful for display
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
      // expenseId surfaced as-is until an Expense model is added
      expenseId: entry.expenseId ?? null,
    },
  }));
}

/* ===============================================================
   GET /api/ledger
   ===============================================================
   Query params (all optional):
     accountType=VENDOR
     accountTypes=VENDOR,CUSTOMER,EXPENSE   (comma-separated)
     entryType=SALE
     entryTypes=SALE,PAYMENT               (comma-separated)
     vendorId=<objectId>
     customerId=<objectId>
     from=2025-01-01
     to=2025-01-31
     page=1
     limit=50
     includeDetails=true                   ← NEW: attach related records
   =============================================================== */
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
      page = 1,
      limit = 50,
      includeDetails = "true", // default ON; pass false to skip the extra lookups
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
    let entryTypeFilter;
    if (entryTypes) {
      entryTypeFilter = entryTypes.split(",");
    } else if (entryType) {
      entryTypeFilter = [entryType];
    }

    /* ---------- Reference Filter ---------- */
    let referenceId;
    if (vendorId)   referenceId = vendorId;
    if (customerId) referenceId = customerId;

    /* ---------- WHERE CLAUSE ---------- */
    const where = {
      ...(entryTypeFilter && { entryType: { in: entryTypeFilter } }),
      ...(from || to
        ? {
            transactionDate: {
              ...(from && { gte: new Date(from) }),
              ...(to && {
                // include the full "to" day
                lte: new Date(new Date(to).setHours(23, 59, 59, 999)),
              }),
            },
          }
        : {}),
      account: {
        ...(accountTypeFilter && { type: { in: accountTypeFilter } }),
        ...(referenceId && { referenceId }),
      },
    };

    /* ---------- Query ---------- */
    const [rawEntries, total] = await Promise.all([
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