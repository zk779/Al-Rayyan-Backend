import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

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

router.get("/", authenticate, async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo,
      branchId,
      vendorId,
      customerId,
      airlineCode,
      agentId,
      paymentStatus,
      saleStatus,
      paymentMethod,
    } = req.query;

    // ── Parse date range (default: last 30 days if not provided) ──────
    const rangeStart = dateFrom ? new Date(dateFrom) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rangeEnd = dateTo ? new Date(dateTo) : new Date();
    // Push end-of-day so "dateTo" is inclusive
    rangeEnd.setHours(23, 59, 59, 999);

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
        });
      }
    }

    // ── Build Sale where clause ────────────────────────────────────────
    const saleWhere = {
      invoice: {
        saleDate: { gte: rangeStart, lte: rangeEnd },
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
    const flatSales = sales.map((s) => {
      const paxVat = s.paxVat || 0;
      const vatAmount = s.vatAmount || 0;
      const vatTotal = paxVat + vatAmount;
      const adjustedProfit = s.profit - vatTotal;

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
        // Raw values, as stored
        grossProfit: s.profit,       // profit INCLUDING vat, as stored in DB
        paxVat,
        vatAmount,
        vatTotal,                    // paxVat + vatAmount, combined
        // Reporting value — this is what should be summed for "profit"
        profit: adjustedProfit,
        paidAmount: s.paidAmount,
        isNegativeSaleEntry: s.profit < 0, // flag so the UI can badge refund-reversal rows if desired
      };
    });

    // ── Build Refund where clause ──────────────────────────────────────
    // Refunds don't carry vendor/customer/branch directly — filter via
    // their related sale, and via processedById for the agent filter.
    const refundWhere = {
      refundDate: { gte: rangeStart, lte: rangeEnd },
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
      expenseDate: { gte: rangeStart, lte: rangeEnd },
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
      meta: {
        dateFrom: rangeStart,
        dateTo: rangeEnd,
        salesCount: flatSales.length,
        refundsCount: flatRefunds.length,
        expensesCount: flatExpenses.length,
      },
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

  // VAT — displayed as its own figure, and already excluded from `profit`
  // on each row above.
  const totalPaxVat = flatSales.reduce((s, r) => s + (r.paxVat || 0), 0);
  const totalVatAmount = flatSales.reduce((s, r) => s + (r.vatAmount || 0), 0);
  const totalVat = totalPaxVat + totalVatAmount;

  // Profit — VAT-excluded, and already includes negative sale rows from
  // refunds (business rule #2), so refunds are NOT subtracted again below.
  const totalProfitExclVat = flatSales.reduce((s, r) => s + (r.profit || 0), 0);

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

  // ✅ Final net revenue formula (business rules #1–#4)
  const netRevenue = totalProfitExclVat + totalCancellationCharges - totalExpenses;

  const outstandingDue = totalSellPrice - totalPaid;

  return {
    totalSellPrice,
    totalNetPrice,
    totalPaid,
    outstandingDue,

    totalPaxVat,
    totalVatAmount,
    totalVat,

    totalProfitExclVat,        // sum of (profit - vat) across all sales, incl. negative refund-reversal rows
    totalCancellationCharges,  // added to profit
    totalRefundedToCustomers,  // informational only
    totalRefundCostToUs,       // informational only

    totalExpenses,

    netRevenue,                // = totalProfitExclVat + totalCancellationCharges - totalExpenses

    salesCount: flatSales.length,
    refundsCount: flatRefunds.length,
    expensesCount: flatExpenses.length,
    avgSaleValue: flatSales.length ? totalSellPrice / flatSales.length : 0,
  };
}

function emptyTotals() {
  return computeTotals([], [], []);
}

// ─────────────────────────────────────────────────────────────
// GET /api/reports/summary
// Lightweight KPI-only endpoint using the same corrected business rules,
// computed via DB aggregates instead of pulling full row-level data.
// ─────────────────────────────────────────────────────────────
router.get("/summary", authenticate, async (req, res) => {
  try {
    const { dateFrom, dateTo, branchId, vendorId, customerId, agentId } = req.query;

    const rangeStart = dateFrom ? new Date(dateFrom) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rangeEnd = dateTo ? new Date(dateTo) : new Date();
    rangeEnd.setHours(23, 59, 59, 999);

    const saleWhere = {
      invoice: {
        saleDate: { gte: rangeStart, lte: rangeEnd },
        ...(agentId ? { userId: agentId } : {}),
        ...(branchId ? { user: { branchId } } : {}),
      },
      ...(vendorId ? { vendorId } : {}),
      ...(customerId ? { customerId } : {}),
    };

    const [salesAgg, refundsAgg, expensesAgg] = await Promise.all([
      // NOTE: aggregate can't compute (profit - paxVat - vatAmount) in one
      // shot, so we sum each field separately and combine below. This still
      // includes negative sale rows in every sum (business rule #2).
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
          refundDate: { gte: rangeStart, lte: rangeEnd },
          ...(agentId ? { processedById: agentId } : {}),
        },
        _sum: { netRefundToCustomer: true, cancellationCharges: true, netCostToUs: true },
        _count: true,
      }),
      prisma.expense.aggregate({
        where: {
          expenseDate: { gte: rangeStart, lte: rangeEnd },
          status: "APPROVED",
          ...(branchId ? { branchId } : {}),
        },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    const totalSellPrice = salesAgg._sum.sellPrice || 0;
    const totalGrossProfit = salesAgg._sum.profit || 0; // includes VAT, as stored
    const totalPaxVat = salesAgg._sum.paxVat || 0;
    const totalVatAmount = salesAgg._sum.vatAmount || 0;
    const totalVat = totalPaxVat + totalVatAmount;
    const totalProfitExclVat = totalGrossProfit - totalVat; // ✅ business rule #1

    const totalPaid = salesAgg._sum.paidAmount || 0;
    const totalCancellationCharges = refundsAgg._sum.cancellationCharges || 0; // ✅ business rule #3
    const totalRefundedToCustomers = refundsAgg._sum.netRefundToCustomer || 0; // informational only
    const totalRefundCostToUs = refundsAgg._sum.netCostToUs || 0; // informational only
    const totalExpenses = expensesAgg._sum.amount || 0;

    // ✅ business rule #2 — refunds NOT subtracted again here, since the
    // negative sale rows already pulled totalGrossProfit/totalProfitExclVat down.
    const netRevenue = totalProfitExclVat + totalCancellationCharges - totalExpenses;

    return res.json({
      success: true,
      data: {
        totalSellPrice,
        totalPaxVat,
        totalVatAmount,
        totalVat,
        totalProfitExclVat,
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