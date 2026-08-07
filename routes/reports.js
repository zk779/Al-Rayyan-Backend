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
        return res.status(401).json({ error: "Missing Authorization header" });

    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await prisma.user.findUnique({ where: { id: decoded.id } });
        if (!user || !user.isActive)
            return res.status(401).json({ error: "User inactive or removed" });

        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid or expired token" });
    }
}

// ─────────────────────────────────────────────────────────────
// Resolve a { gte, lte } date filter from optional dateFrom/dateTo
// query params, using the caller's local timezone.
//
//  - Both given  -> full inclusive range across local calendar days
//  - Only "from" -> open-ended upward (from that local day's start onward)
//  - Only "to"   -> open-ended downward (up to that local day's end)
//  - Neither     -> null (no filter at all -> "complete" / all-time report)
// ─────────────────────────────────────────────────────────────
function resolveDateFilter(dateFrom, dateTo, timeZone) {
    if (!dateFrom && !dateTo) return null;

    const filter = {};

    if (dateFrom) {
        const range = localDayRangeToUtc(dateFrom, timeZone);
        if (range) filter.gte = range.start;
    }

    if (dateTo) {
        const range = localDayRangeToUtc(dateTo, timeZone);
        if (range) filter.lte = range.end;
    }

    return Object.keys(filter).length ? filter : null;
}

router.get("/", authenticate, async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo,
      timeZone,
      branchId,
      vendorId,
      customerId,
      airlineCode,
      agentId,
      paymentStatus,
      saleStatus,
      paymentMethod,
    } = req.query;

    // ── Resolve local-timezone-aware date filter (null = complete/all-time) ──
    const dateFilter = resolveDateFilter(dateFrom, dateTo, timeZone);

    // ── Resolve airlineCode -> airlineId (Sale stores airlineId, not code) ──
    let airlineId;
    if (airlineCode) {
      const airline = await prisma.airlineCode.findFirst({
        where: {
          OR: [{ airlineCode }, { iataName: airlineCode }],
        },
        select: { id: true },
      });
      airlineId = airline?.id;
      // If a code was given but nothing matched, force an empty result
      // rather than silently ignoring the filter.
      if (!airlineId) {
        return res.json({
          success: true,
          data: { sales: [], refunds: [], expenses: [] },
          totals: emptyTotals(),
          meta: buildMeta(dateFilter, { sales: 0, refunds: 0, expenses: 0 }),
        });
      }
    }

    // ── Build Sale where clause ────────────────────────────────────────
    const saleWhere = {
      invoice: {
        ...(dateFilter ? { saleDate: dateFilter } : {}),
        ...(agentId ? { userId: agentId } : {}),
        ...(branchId ? { user: { branchId } } : {}),
      },
      ...(vendorId ? { vendorId } : {}),
      ...(customerId ? { customerId } : {}),
      ...(airlineId ? { airlineId } : {}),
      ...(paymentStatus ? { paymentStatus } : {}),
      ...(saleStatus ? { status: saleStatus } : {}),
      ...(paymentMethod ? { paymentType: paymentMethod } : {}),
    };

    const sales = await prisma.sale.findMany({
      where: saleWhere,
      include: {
        invoice: {
          include: {
            user: {
              select: { id: true, fullName: true, branchId: true },
            },
          },
        },
        airline: { select: { airlineName: true, airlineCode: true, iataName: true } },
        vendor: { select: { id: true, vendorName: true } },
        customer: { select: { id: true, customerName: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // ── Flatten sales into report-friendly rows ────────────────────────
    // NOTE: this includes negative sale rows created by refunds — that's
    // intentional, see business rule #2 above.
    //
    // NOTE: profit is reported as-stored (s.profit). paxVat/vatAmount are
    // no longer subtracted out — VAT is purely informational here, not a
    // profit deduction.
    const flatSales = sales.map((s) => {
      const paxVat = s.paxVat || 0;
      const vatAmount = s.vatAmount || 0;
      const vatTotal = paxVat + vatAmount;

      return {
        id: s.id,
        date: s.invoice?.saleDate ?? s.createdAt,
        invoiceNumber: s.invoice?.invoiceNo ?? null,
        airline: s.airline?.airlineCode ?? s.airline?.iataName ?? "-",
        airlineName: s.airline?.airlineName ?? "-",
        vendor: s.vendor?.vendorName ?? "-",
        vendorId: s.vendorId,
        customer: s.customer?.customerName ?? "",
        customerId: s.customerId,
        branchId: s.invoice?.user?.branchId ?? null,
        agent: s.invoice?.user?.fullName ?? "-",
        agentId: s.invoice?.userId ?? null,
        paymentMethod: s.paymentType,
        paymentStatus: s.paymentStatus,
        status: s.status,
        netPrice: s.netPrice,
        sellPrice: s.sellPrice,
        // Profit as stored — no VAT subtraction.
        profit: s.profit,
        // VAT — informational only, not deducted from profit.
        paxVat,
        vatAmount,
        vatTotal,
        paidAmount: s.paidAmount,
        isNegativeSaleEntry: s.profit < 0, // flag so the UI can badge refund-reversal rows if desired
      };
    });

    // ── Build Refund where clause ──────────────────────────────────────
    // Refunds don't carry vendor/customer/branch directly — filter via
    // their related sale, and via processedById for the agent filter.
    const refundWhere = {
      ...(dateFilter ? { refundDate: dateFilter } : {}),
      ...(agentId ? { processedById: agentId } : {}),
      ...(vendorId || customerId || branchId || airlineId
        ? {
            sale: {
              ...(vendorId ? { vendorId } : {}),
              ...(customerId ? { customerId } : {}),
              ...(airlineId ? { airlineId } : {}),
              ...(branchId ? { invoice: { user: { branchId } } } : {}),
            },
          }
        : {}),
    };

    const refunds = await prisma.refund.findMany({
      where: refundWhere,
      include: {
        sale: {
          include: {
            vendor: { select: { vendorName: true } },
            customer: { select: { customerName: true } },
            invoice: { select: { invoiceNo: true } },
          },
        },
        processedBy: { select: { fullName: true } },
      },
      orderBy: { refundDate: "desc" },
    });

    const flatRefunds = refunds.map((r) => ({
      id: r.id,
      saleId: r.saleId,
      date: r.refundDate,
      status: r.status,
      originalAmount: r.originalSaleAmount,
      customerRefundAmount: r.customerRefundAmount,
      vendorRefundAmount: r.vendorRefundAmount,
      refundFee: r.refundFee,
      cancellationCharges: r.cancellationCharges || 0, // treated as profit — see rule #3
      netRefundToCustomer: r.netRefundToCustomer,
      netCostToUs: r.netCostToUs,
      refundReason: r.refundReason,
      remarks: r.remarks,
      vendor: r.sale?.vendor?.vendorName ?? "-",
      customer: r.sale?.customer?.customerName ?? "-",
      invoiceNumber: r.sale?.invoice?.invoiceNo ?? "-",
      agent: r.processedBy?.fullName ?? "-",
    }));

    // ── Build Expense where clause ──────────────────────────────────────
    // Only APPROVED expenses post to the ledger and count toward reports.
    const expenseWhere = {
      ...(dateFilter ? { expenseDate: dateFilter } : {}),
      status: "APPROVED",
      ...(branchId ? { branchId } : {}),
      ...(agentId ? { userId: agentId } : {}),
    };

    const expenses = await prisma.expense.findMany({
      where: expenseWhere,
      include: {
        branch: { select: { name: true } },
        user: { select: { fullName: true } },
      },
      orderBy: { expenseDate: "desc" },
    });

    const flatExpenses = expenses.map((e) => ({
      id: e.id,
      expenseDate: e.expenseDate,
      category: e.category,
      amount: e.amount,
      branchId: e.branchId,
      branchName: e.branch?.name ?? "-",
      paymentMode: e.paymentMode,
      description: e.description,
      agent: e.user?.fullName ?? "-",
    }));

    // ── Compute report-wide totals using the corrected business rules ───
    const totals = computeTotals(flatSales, flatRefunds, flatExpenses);

    return res.json({
      success: true,
      data: {
        sales: flatSales,
        refunds: flatRefunds,
        expenses: flatExpenses,
      },
      totals,
      meta: buildMeta(dateFilter, {
        sales: flatSales.length,
        refunds: flatRefunds.length,
        expenses: flatExpenses.length,
      }),
    });
  } catch (err) {
    console.error("GET /api/reports error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error while generating report",
    });
  }
});

// ─────────────────────────────────────────────────────────────
// Shared totals calculator — used by both the row-level "/" endpoint
// and can be reused anywhere else totals need to be derived consistently.
// ─────────────────────────────────────────────────────────────
function computeTotals(flatSales, flatRefunds, flatExpenses) {
  const totalSellPrice = flatSales.reduce((s, r) => s + (r.sellPrice || 0), 0);
  const totalNetPrice = flatSales.reduce((s, r) => s + (r.netPrice || 0), 0);
  const totalPaid = flatSales.reduce((s, r) => s + (r.paidAmount || 0), 0);

  // VAT — displayed as its own figure. Informational only; NOT deducted
  // from profit anywhere below.
  const totalPaxVat = flatSales.reduce((s, r) => s + (r.paxVat || 0), 0);
  const totalVatAmount = flatSales.reduce((s, r) => s + (r.vatAmount || 0), 0);
  const totalVat = totalPaxVat + totalVatAmount;

  // Profit — as stored, no VAT subtraction. Already includes negative sale
  // rows from refunds (business rule #2), so refunds are NOT subtracted
  // again below.
  const totalProfit = flatSales.reduce((s, r) => s + (r.profit || 0), 0);

  // Cancellation charges are profit kept by the business — add on top.
  const totalCancellationCharges = flatRefunds.reduce(
    (s, r) => s + (r.cancellationCharges || 0),
    0,
  );

  // Informational only — NOT subtracted from netRevenue (already reflected
  // via the negative sale rows). Still useful to display for transparency.
  const totalRefundedToCustomers = flatRefunds.reduce(
    (s, r) => s + (r.netRefundToCustomer || 0),
    0,
  );
  const totalRefundCostToUs = flatRefunds.reduce(
    (s, r) => s + (r.netCostToUs || 0),
    0,
  );

  const totalExpenses = flatExpenses.reduce((s, e) => s + (e.amount || 0), 0);

  // ✅ Final net revenue formula:
  //    sale profit (as stored) + cancellation charges kept − expenses
  const netRevenue = totalProfit + totalCancellationCharges - totalExpenses;

  const outstandingDue = totalSellPrice - totalPaid;

  return {
    totalSellPrice,
    totalNetPrice,
    totalPaid,
    outstandingDue,

    totalPaxVat,      // informational only
    totalVatAmount,   // informational only
    totalVat,         // informational only

    totalProfit,                // sum of raw sale profit, incl. negative refund-reversal rows
    totalCancellationCharges,   // added to profit
    totalRefundedToCustomers,   // informational only
    totalRefundCostToUs,        // informational only

    totalExpenses,

    netRevenue,                 // = totalProfit + totalCancellationCharges - totalExpenses

    salesCount: flatSales.length,
    refundsCount: flatRefunds.length,
    expensesCount: flatExpenses.length,
    avgSaleValue: flatSales.length ? totalSellPrice / flatSales.length : 0,
  };
}

function emptyTotals() {
  return computeTotals([], [], []);
}

function buildMeta(dateFilter, counts) {
  return {
    dateFrom: dateFilter?.gte ?? null,
    dateTo: dateFilter?.lte ?? null,
    isCompleteRange: !dateFilter, // true when no dateFrom/dateTo was given (all-time report)
    salesCount: counts.sales,
    refundsCount: counts.refunds,
    expensesCount: counts.expenses,
  };
}

// ─────────────────────────────────────────────────────────────
// GET /api/reports/summary
// Lightweight KPI-only endpoint using the same corrected business rules,
// computed via DB aggregates instead of pulling full row-level data.
// ─────────────────────────────────────────────────────────────
router.get("/summary", authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo, timeZone, branchId, vendorId, customerId, agentId } = req.query;

    const dateFilter = resolveDateFilter(dateFrom, dateTo, timeZone);

    const saleWhere = {
      invoice: {
        ...(dateFilter ? { saleDate: dateFilter } : {}),
        ...(agentId ? { userId: agentId } : {}),
        ...(branchId ? { user: { branchId } } : {}),
      },
      ...(vendorId ? { vendorId } : {}),
      ...(customerId ? { customerId } : {}),
    };

    const [salesAgg, refundsAgg, expensesAgg] = await Promise.all([
      prisma.sale.aggregate({
        where: saleWhere,
        _sum: {
          sellPrice: true,
          profit: true,
          netPrice: true,
          paidAmount: true,
          paxVat: true,
          vatAmount: true,
        },
        _count: true,
      }),
      prisma.refund.aggregate({
        where: {
          ...(dateFilter ? { refundDate: dateFilter } : {}),
          ...(agentId ? { processedById: agentId } : {}),
        },
        _sum: { netRefundToCustomer: true, cancellationCharges: true, netCostToUs: true },
        _count: true,
      }),
      prisma.expense.aggregate({
        where: {
          ...(dateFilter ? { expenseDate: dateFilter } : {}),
          status: "APPROVED",
          ...(branchId ? { branchId } : {}),
        },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    const totalSellPrice = salesAgg._sum.sellPrice || 0;
    // ✅ Profit as stored — no VAT subtraction.
    const totalProfit = salesAgg._sum.profit || 0;
    const totalPaxVat = salesAgg._sum.paxVat || 0;
    const totalVatAmount = salesAgg._sum.vatAmount || 0;
    const totalVat = totalPaxVat + totalVatAmount; // informational only

    const totalPaid = salesAgg._sum.paidAmount || 0;
    const totalCancellationCharges = refundsAgg._sum.cancellationCharges || 0; // ✅ business rule #3
    const totalRefundedToCustomers = refundsAgg._sum.netRefundToCustomer || 0; // informational only
    const totalRefundCostToUs = refundsAgg._sum.netCostToUs || 0; // informational only
    const totalExpenses = expensesAgg._sum.amount || 0;

    // ✅ business rule #2 — refunds NOT subtracted again here, since the
    // negative sale rows already pulled totalProfit down.
    const netRevenue = totalProfit + totalCancellationCharges - totalExpenses;

    return res.json({
      success: true,
      data: {
        totalSellPrice,
        totalPaxVat,
        totalVatAmount,
        totalVat,
        totalProfit,
        totalCancellationCharges,
        totalRefundedToCustomers,
        totalRefundCostToUs,
        totalExpenses,
        outstandingDue: totalSellPrice - totalPaid,
        netRevenue,
        salesCount: salesAgg._count,
        refundsCount: refundsAgg._count,
        expensesCount: expensesAgg._count,
        avgSaleValue: salesAgg._count ? totalSellPrice / salesAgg._count : 0,
      },
      meta: {
        dateFrom: dateFilter?.gte ?? null,
        dateTo: dateFilter?.lte ?? null,
        isCompleteRange: !dateFilter,
      },
    });
  } catch (err) {
    console.error("GET /api/reports/summary error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error while generating summary",
    });
  }
});

export default router;