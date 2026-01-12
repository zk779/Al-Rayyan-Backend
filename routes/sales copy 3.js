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

/* ------------------------------------------------------------------------ */
/* ✅ CREATE SALES (Invoice + Multiple Sales + Vendor Ledger Entries)       */
/* ------------------------------------------------------------------------ */
router.get("/", authenticate, async (req, res) => {
  try {
    const { search } = req.query;

    const whereClause = search
      ? {
          OR: [
            {
              invoiceNo: {
                contains: search,
                mode: "insensitive",
              },
            },
            {
              sales: {
                some: {
                  OR: [
                    {
                      documentNo: {
                        contains: search,
                        mode: "insensitive",
                      },
                    },
                    {
                      remarks: {
                        contains: search,
                        mode: "insensitive",
                      },
                    },
                  ],
                },
              },
            },
          ],
        }
      : {};

    const invoices = await prisma.salesInvoice.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: { id: true, fullName: true, email: true },
        },
        sales: {
          select: {
            id: true,
            netPrice: true,
            sellPrice: true,
            profit: true,
            status: true,
            documentNo: true,
            paymentType: true,
            customerId: true,
            remarks: true,
            vendor: {
              select: {
                vendorName: true,
                account: { select: { balance: true } }, // ✅ unified ledger
              },
            },
            airline: {
              select: { airlineCode: true },
            },
            customer: {
              select: {
                customerName: true,
                phone: true,
                account: { select: { balance: true } }, // ✅ unified ledger
              },
            },
          },
        },
      },
    });

    const data = invoices.map((inv) => ({
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      saleDate: inv.saleDate,

      createdById: inv.user?.id || null,
      createdByName: inv.user?.fullName || null,
      createdByEmail: inv.user?.email || null,

      totalNet: inv.totalNet,
      totalSell: inv.totalSell,
      totalProfit: inv.totalProfit,
      salesCount: inv.sales.length,

      sales: inv.sales.map((s) => ({
        id: s.id,
        vendorName: s.vendor?.vendorName || null,
        vendorBalance: s.vendor?.account?.balance ?? null,
        airlineCode: s.airline?.airlineCode || null,
        paymentType: s.paymentType,
        documentNo: s.documentNo,
        customerId: s.customerId || null,
        customerName: s.customer?.customerName || null,
        customerPhone: s.customer?.phone || null,
        customerBalance: s.customer?.account?.balance ?? null,
        netPrice: s.netPrice,
        sellPrice: s.sellPrice,
        remarks: s.remarks,
        profit: s.profit,
        status: s.status,
      })),

      createdAt: inv.createdAt,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch sales invoices",
    });
  }
});

router.get("/search", authenticate, async (req, res) => {
  try {
    const { documentNo } = req.query;

    if (!documentNo) {
      return res.status(400).json({
        success: false,
        error: "documentNo is required",
      });
    }

    /**
     * STEP 1️⃣
     * Find all sales matching document number
     * (including refunded ones)
     */
    const sales = await prisma.sale.findMany({
      where: {
        documentNo: {
          contains: documentNo,
          mode: "insensitive",
        },
      },
      orderBy: {
        createdAt: "desc", // 🔥 MOST IMPORTANT
      },
      include: {
        airline: {
          select: { airlineCode: true },
        },
        vendor: {
          select: {
            vendorName: true,
            account: { select: { balance: true } },
          },
        },
        customer: {
          select: {
            customerName: true,
            phone: true,
            account: { select: { balance: true } },
          },
        },
        refund: true, // to know if refund record exists
      },
    });

    if (sales.length === 0) {
      return res.json({ success: true, data: [] });
    }

    /**
     * STEP 2️⃣
     * Group by documentNo and keep only latest sale
     */
    const latestSaleByDoc = new Map();

    for (const sale of sales) {
      if (!latestSaleByDoc.has(sale.documentNo)) {
        latestSaleByDoc.set(sale.documentNo, sale);
      }
    }

    /**
     * STEP 3️⃣
     * Prepare response
     */
    const data = Array.from(latestSaleByDoc.values()).map((s) => ({
      id: s.id,
      documentNo: s.documentNo,
      netPrice: s.netPrice,
      sellPrice: s.sellPrice,
      profit: s.profit,
      status: s.status,
      isRefund: s.isRefund,

      airlineCode: s.airline?.airlineCode || null,

      vendorName: s.vendor?.vendorName || null,
      vendorBalance: s.vendor?.account?.balance ?? null,

      customerName: s.customer?.customerName || null,
      customerPhone: s.customer?.phone || null,
      customerBalance: s.customer?.account?.balance ?? null,

      createdAt: s.createdAt,
      refundedAt: s.refund?.refundDate || null,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: "Failed to search sales",
    });
  }
});

/* ===========================
   GET INVOICE BY ID (WITH USER)
=========================== */
router.get("/:invoiceId", authenticate, async (req, res) => {
  try {
    const invoice = await prisma.salesInvoice.findUnique({
      where: { id: req.params.invoiceId },
      include: {
        user: {
          select: { id: true, fullName: true, email: true },
        },
        sales: {
          include: {
            vendor: {
              select: {
                id: true,
                vendorName: true,
                category: true,
                account: { select: { balance: true } }, // ✅ unified ledger
              },
            },
            airline: {
              select: {
                id: true,
                airlineName: true,
                airlineCode: true,
              },
            },
            customer: {
              select: {
                id: true,
                customerName: true,
                customerType: true,
                phone: true,
                contactPerson: true,
                account: { select: { balance: true } }, // ✅ unified ledger
              },
            },
          },
        },
      },
    });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: "Invoice not found",
      });
    }

    res.json({
      success: true,
      data: {
        ...invoice,
        salesCount: invoice.sales.length,

        createdById: invoice.user?.id || null,
        createdByName: invoice.user?.fullName || null,
        createdByEmail: invoice.user?.email || null,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch invoice",
    });
  }
});

/* ===========================
   CREATE SALES (INVOICE HAS userId)
=========================== */
router.post("/", authenticate, async (req, res) => {
  const { invoiceNo, saleDate, sales = [], refunds = [] } = req.body;

  if (!invoiceNo) {
    return res
      .status(400)
      .json({ success: false, error: "invoiceNo is required" });
  }

  if (!Array.isArray(sales) || !Array.isArray(refunds)) {
    return res.status(400).json({
      success: false,
      error: "sales and refunds must be arrays",
    });
  }

  if (sales.length === 0 && refunds.length === 0) {
    return res.status(400).json({
      success: false,
      error: "At least one sale or refund is required",
    });
  }

  try {
    /* ======================================================
       1️⃣ READ PHASE (NO TRANSACTION)
    ====================================================== */

    // ---- Validate sales payload basics ----
    for (const s of sales) {
      // if (!s.vendorId) throw new Error("vendorId is required in sales");
      // if (!s.airlineId) throw new Error("airlineId is required in sales");
      if (s.netPrice == null || s.sellPrice == null) {
        throw new Error("netPrice and sellPrice are required in sales");
      }
      const net = Number(s.netPrice);
      const sell = Number(s.sellPrice);
      if (Number.isNaN(net) || Number.isNaN(sell))
        throw new Error("netPrice/sellPrice must be numbers");
      if (net < 0 || sell < 0)
        throw new Error("netPrice/sellPrice cannot be negative");

      const paidAmount = Number(s.paidAmount || 0);
      if (paidAmount < 0) throw new Error("Paid amount cannot be negative");
      if (paidAmount > sell)
        throw new Error("Paid amount cannot exceed sell price");

      if (String(s.paymentType || "").toUpperCase() === "CREDIT") {
        if (!s.customerId)
          throw new Error("customerId is required for CREDIT sales");
      }
    }

    // ---- Validate refunds payload basics ----
    for (const r of refunds) {
      if (!r.saleId) throw new Error("saleId is required in refunds");

      const amt = Number(r.refundableAmount);
      if (!amt || Number.isNaN(amt) || amt <= 0) {
        throw new Error("refundableAmount must be a positive number");
      }

      const fee = Number(r.refundFee || 0);
      const sc = Number(r.serviceCharges || 0);
      if (Number.isNaN(fee) || fee < 0)
        throw new Error("refundFee must be >= 0");
      if (Number.isNaN(sc) || sc < 0)
        throw new Error("serviceCharges must be >= 0");
    }

    // ---- Fetch original sales that are being refunded ----
    const refundSaleIds = [...new Set(refunds.map((r) => r.saleId))];

    const originalSales = refundSaleIds.length
      ? await prisma.sale.findMany({
          where: { id: { in: refundSaleIds } },
          include: {
            vendor: { include: { account: true } },
            customer: { include: { account: true } },
          },
        })
      : [];

    const originalSaleMap = Object.fromEntries(
      originalSales.map((s) => [s.id, s])
    );

    // Ensure all saleIds exist + validate
    for (const r of refunds) {
      if (!originalSaleMap[r.saleId]) {
        throw new Error(
          `Original sale not found for refund saleId=${r.saleId}`
        );
      }
      const orig = originalSaleMap[r.saleId];

      if (orig.isRefund) {
        throw new Error(
          `Cannot refund a refund sale entry (saleId=${r.saleId})`
        );
      }

      if (Number(r.refundableAmount) > Number(orig.sellPrice)) {
        throw new Error(
          `Refund exceeds original sell price for saleId=${r.saleId}`
        );
      }
    }

    // ---- Prevent over-refund by checking already refunded totals ----
    const existingRefundSales = refundSaleIds.length
      ? await prisma.sale.findMany({
          where: {
            isRefund: true,
            refundOfSaleId: { in: refundSaleIds },
          },
          select: {
            refundOfSaleId: true,
            sellPrice: true, // negative
          },
        })
      : [];

    const alreadyRefundedMap = {}; // originalSaleId -> absolute refunded total
    for (const rs of existingRefundSales) {
      const k = rs.refundOfSaleId;
      const refunded = Math.abs(Number(rs.sellPrice || 0));
      alreadyRefundedMap[k] = (alreadyRefundedMap[k] || 0) + refunded;
    }

    for (const r of refunds) {
      const orig = originalSaleMap[r.saleId];
      const alreadyRefunded = alreadyRefundedMap[r.saleId] || 0;
      const remaining = Number(orig.sellPrice) - alreadyRefunded;

      if (Number(r.refundableAmount) > remaining) {
        throw new Error(
          `Refund exceeds remaining refundable amount for saleId=${r.saleId}. Remaining=${remaining}`
        );
      }
    }

    // ---- Load vendors/customers for NEW sales ----
    const saleVendorIds = [...new Set(sales.map((s) => s.vendorId))];
    const saleCustomerIds = [
      ...new Set(
        sales
          .filter((s) => String(s.paymentType).toUpperCase() === "CREDIT")
          .map((s) => s.customerId)
          .filter(Boolean)
      ),
    ];

    const vendors = saleVendorIds.length
      ? await prisma.vendor.findMany({
          where: { id: { in: saleVendorIds } },
          include: { account: true },
        })
      : [];

    const customers = saleCustomerIds.length
      ? await prisma.customer.findMany({
          where: { id: { in: saleCustomerIds } },
          include: { account: true },
        })
      : [];

    const vendorMap = Object.fromEntries(vendors.map((v) => [v.id, v]));
    const customerMap = Object.fromEntries(customers.map((c) => [c.id, c]));

    for (const s of sales) {
      const v = vendorMap[s.vendorId];
      if (!v)
        throw new Error(`Vendor not found for sale vendorId=${s.vendorId}`);

      if (String(s.paymentType).toUpperCase() === "CREDIT") {
        const c = customerMap[s.customerId];
        if (!c || !c.isActive) {
          throw new Error(
            `Invalid/inactive customer for customerId=${s.customerId}`
          );
        }
      }
    }

    /* ======================================================
       2️⃣ WRITE PHASE (TRANSACTION)
    ====================================================== */

    const businessDate = saleDate ? new Date(saleDate) : new Date();

    // ✅ FIX: Increase interactive transaction timeout
    const result = await prisma.$transaction(
      async (tx) => {
        const invoice = await tx.salesInvoice.create({
          data: {
            invoiceNo,
            saleDate: businessDate,
            userId: req.user.id,
          },
        });

        // In-memory balances
        const balanceByAccountId = new Map();

        for (const v of vendors) {
          balanceByAccountId.set(v.account.id, Number(v.account.balance || 0));
        }
        for (const c of customers) {
          balanceByAccountId.set(c.account.id, Number(c.account.balance || 0));
        }

        for (const os of originalSales) {
          if (
            os.vendor?.account?.id &&
            !balanceByAccountId.has(os.vendor.account.id)
          ) {
            balanceByAccountId.set(
              os.vendor.account.id,
              Number(os.vendor.account.balance || 0)
            );
          }
          if (
            os.customer?.account?.id &&
            !balanceByAccountId.has(os.customer.account.id)
          ) {
            balanceByAccountId.set(
              os.customer.account.id,
              Number(os.customer.account.balance || 0)
            );
          }
        }

        const getBal = (accountId) =>
          Number(balanceByAccountId.get(accountId) || 0);
        const setBal = (accountId, val) =>
          balanceByAccountId.set(accountId, Number(val));

        let totalNet = 0;
        let totalSell = 0;
        let totalProfit = 0;

        /* =======================
           ✅ NEW SALES
        ======================= */
        for (const s of sales) {
          const net = Number(s.netPrice);
          const sell = Number(s.sellPrice);
          const profit = sell - net;

          const paidAmount = Number(s.paidAmount || 0);

          let paymentStatus = "DUE";
          if (paidAmount === sell) paymentStatus = "PAID";
          else if (paidAmount > 0) paymentStatus = "PARTIAL";

          const vendor = vendorMap[s.vendorId];
          const vendorAccountId = vendor.account.id;
          const isDebitVendor = vendor.category === "DEBIT";

          const vendorCurrent = getBal(vendorAccountId);
          if (isDebitVendor && vendorCurrent < net) {
            throw new Error(
              `Insufficient balance for debit vendor ${vendor.vendorName}`
            );
          }

          const vendorBalanceAfterSale = isDebitVendor
            ? vendorCurrent - net
            : vendorCurrent + net;

          const sale = await tx.sale.create({
            data: {
              invoiceId: invoice.id,
              airlineId: s.airlineId,
              vendorId: s.vendorId,
              customerId: s.customerId || null,
              documentNo: s.documentNo || null,
              netPrice: net,
              sellPrice: sell,
              profit,
              paymentType: s.paymentType,
              paidAmount,
              paymentStatus,
              remarks: s.remarks || null,
              status: "COMPLETED",
              isRefund: false,
            },
          });

          await tx.ledgerEntry.create({
            data: {
              accountId: vendorAccountId,
              entryType: "SALE",
              debit: isDebitVendor ? 0 : net,
              credit: isDebitVendor ? net : 0,
              balanceAfter: vendorBalanceAfterSale,
              transactionDate: businessDate,
              saleId: sale.id,
              invoiceId: invoice.id,
            },
          });

          await tx.account.update({
            where: { id: vendorAccountId },
            data: { balance: vendorBalanceAfterSale },
          });

          setBal(vendorAccountId, vendorBalanceAfterSale);

          if (
            String(s.paymentType).toUpperCase() === "CREDIT" &&
            s.customerId
          ) {
            const customer = customerMap[s.customerId];
            const customerAccountId = customer.account.id;
            const customerCurrent = getBal(customerAccountId);

            const customerBalanceAfterSale = customerCurrent + sell;

            await tx.ledgerEntry.create({
              data: {
                accountId: customerAccountId,
                entryType: "SALE",
                debit: sell,
                credit: 0,
                balanceAfter: customerBalanceAfterSale,
                transactionDate: businessDate,
                saleId: sale.id,
                invoiceId: invoice.id,
              },
            });

            await tx.account.update({
              where: { id: customerAccountId },
              data: { balance: customerBalanceAfterSale },
            });

            setBal(customerAccountId, customerBalanceAfterSale);
          }

          totalNet += net;
          totalSell += sell;
          totalProfit += profit;
        }

        /* =======================
           ✅ REFUNDS (negative sale + ledgers + refund extras)
        ======================= */
        for (const r of refunds) {
          const originalSale = originalSaleMap[r.saleId];
          if (!originalSale) throw new Error("Sale to refund not found");

          const baseAmount = Number(originalSale.netPrice); // 250
          const baseSellPrice = Number(originalSale.sellPrice); // 300
          const refundFee = Number(r.refundFee || 0); // 30
          const serviceCharges = Number(r.serviceCharges || 0); // 20

          if (refundFee + serviceCharges > baseAmount) {
            throw new Error("Refund fees exceed refundable amount");
          }

          const customerRefundAmount = baseAmount - refundFee - serviceCharges; // 200
          const vendorRefundAmount = baseAmount - refundFee; // 220

          /* ------------------------------------------------
     1️⃣ CREATE NEGATIVE SALE (FULL REVERSAL)
  ------------------------------------------------ */
          const refundSale = await tx.sale.create({
            data: {
              invoiceId: invoice.id,
              airlineId: originalSale.airlineId,
              vendorId: originalSale.vendorId,
              customerId: originalSale.customerId,
              documentNo: originalSale.documentNo,
              netPrice: -baseAmount,
              sellPrice: -baseSellPrice,
              profit: 0,
              paymentType: originalSale.paymentType,
              paidAmount: 0,
              paymentStatus: "PAID",
              status: "REFUNDED",
              isRefund: true,
              refundOfSaleId: originalSale.id,
              remarks: r.remarks || "Refund",
            },
          });

          /* ------------------------------------------------
     2️⃣ REFUND METADATA
  ------------------------------------------------ */
          const refundRow = await tx.refund.create({
            data: {
              saleId: refundSale.id,
              originalAmount: baseAmount,
              refundableAmount: customerRefundAmount,
              vendorRefundAmount: vendorRefundAmount,
              refundFee,
              serviceCharges,
              refundReason: r.refundReason || null,
              remarks: r.remarks || null,
              refundDate: r.refundDate ? new Date(r.refundDate) : businessDate,
            },
          });

          /* ------------------------------------------------
     3️⃣ VENDOR LEDGER (CREDIT 220)
  ------------------------------------------------ */
          const vendorAccountId = originalSale.vendor.account.id;
          const vendorCurrent = getBal(vendorAccountId);
          const vendorBalanceAfter = vendorCurrent + vendorRefundAmount;

          await tx.ledgerEntry.create({
            data: {
              accountId: vendorAccountId,
              entryType: "ADJUSTMENT",
              debit: 0,
              credit: vendorRefundAmount,
              balanceAfter: vendorBalanceAfter,
              transactionDate: businessDate,
              saleId: refundSale.id,
              refundId: refundRow.id,
              invoiceId: invoice.id,
              remarks: "Vendor refund (after refund fee)",
            },
          });

          await tx.account.update({
            where: { id: vendorAccountId },
            data: { balance: vendorBalanceAfter },
          });

          setBal(vendorAccountId, vendorBalanceAfter);

          /* ------------------------------------------------
     4️⃣ CUSTOMER LEDGER (CREDIT 200) — CREDIT SALE ONLY
  ------------------------------------------------ */
          if (
            originalSale.paymentType === "CREDIT" &&
            originalSale.customer?.account?.id
          ) {
            const customerAccountId = originalSale.customer.account.id;
            const customerCurrent = getBal(customerAccountId);
            const customerBalanceAfter = customerCurrent - customerRefundAmount;

            await tx.ledgerEntry.create({
              data: {
                accountId: customerAccountId,
                entryType: "ADJUSTMENT",
                debit: 0,
                credit: customerRefundAmount,
                balanceAfter: customerBalanceAfter,
                transactionDate: businessDate,
                saleId: refundSale.id,
                refundId: refundRow.id,
                invoiceId: invoice.id,
                remarks: "Customer refund (after fees)",
              },
            });

            await tx.account.update({
              where: { id: customerAccountId },
              data: { balance: customerBalanceAfter },
            });

            setBal(customerAccountId, customerBalanceAfter);
          }

          /* ------------------------------------------------
     5️⃣ OPTIONAL: FEE INCOME ENTRIES (RECOMMENDED)
  ------------------------------------------------ */

          /* ------------------------------------------------
     6️⃣ UPDATE INVOICE TOTALS
  ------------------------------------------------ */
          totalNet += -baseAmount;
          totalSell += -baseAmount;
        }

        // ✅ Keep your logic: update invoice totals in DB
        const updatedInvoice = await tx.salesInvoice.update({
          where: { id: invoice.id },
          data: { totalNet, totalSell, totalProfit },
        });

        return updatedInvoice;
      },
      {
        timeout: 20000, // ✅ increase from 5s → 20s
        maxWait: 20000,
      }
    );

    return res.status(201).json({
      success: true,
      message:
        "Sales and refunds processed successfully (refunds as negative sales)",
      data: result,
    });
  } catch (err) {
    console.error(err);
    return res.status(400).json({
      success: false,
      error: err.message,
    });
  }
});

router.put("/:invoiceId", authenticate, async (req, res) => {
  const { invoiceId } = req.params;
  const { saleDate, sales } = req.body;

  if (!Array.isArray(sales) || sales.length === 0) {
    return res.status(400).json({
      success: false,
      error: "sales array is required",
    });
  }

  try {
    /* ================= READ PHASE ================= */

    const invoice = await prisma.salesInvoice.findUnique({
      where: { id: invoiceId },
      include: {
        sales: true,
      },
    });
    if (!invoice) throw new Error("Invoice not found");

    if (invoice.sales.length !== sales.length) {
      throw new Error("Sales count mismatch");
    }

    const vendorMap = {};
    const vendorAccountMap = {};
    const oldVendorSaleEntryMap = {};

    for (const s of invoice.sales) {
      const vendor =
        vendorMap[s.vendorId] ||
        (vendorMap[s.vendorId] = await prisma.vendor.findUnique({
          where: { id: s.vendorId },
          include: { account: true },
        }));

      if (!vendor || !vendor.account)
        throw new Error("Vendor or vendor account missing");

      vendorAccountMap[s.vendorId] = vendor.account;

      const saleEntry = await prisma.ledgerEntry.findFirst({
        where: {
          saleId: s.id,
          entryType: "SALE",
        },
        orderBy: { createdAt: "asc" },
      });

      if (!saleEntry) {
        throw new Error("Ledger SALE entry missing");
      }

      oldVendorSaleEntryMap[s.id] = saleEntry;
    }

    /* ================= WRITE PHASE ================= */

    const result = await prisma.$transaction(async (tx) => {
      let totalNet = 0;
      let totalSell = 0;
      let totalProfit = 0;

      for (const payload of sales) {
        const sale = invoice.sales.find((s) => s.id === payload.saleId);
        if (!sale) throw new Error("Sale not found");

        const vendor = vendorMap[sale.vendorId];
        const account = vendorAccountMap[sale.vendorId];
        const oldEntry = oldVendorSaleEntryMap[sale.id];

        const oldNet = sale.netPrice;
        const newNet = Number(payload.netPrice);
        const oldSell = sale.sellPrice;
        const newSell = Number(payload.sellPrice);

        if (
          Number.isNaN(newNet) ||
          Number.isNaN(newSell) ||
          newNet < 0 ||
          newSell < 0
        ) {
          throw new Error("Invalid price values");
        }

        const deltaNet = newNet - oldNet;
        const deltaSell = newSell - oldSell;
        const newProfit = newSell - newNet;

        /* -------- Vendor Balance Check (DEBIT vendor) -------- */
        if (
          vendor.category === "DEBIT" &&
          deltaNet > 0 &&
          account.balance < deltaNet
        ) {
          throw new Error(
            `Insufficient balance for debit vendor ${vendor.vendorName}`
          );
        }

        /* -------- Update Sale -------- */
        await tx.sale.update({
          where: { id: sale.id },
          data: {
            documentNo: payload.documentNo,
            netPrice: newNet,
            sellPrice: newSell,
            profit: newProfit,
            paymentType: payload.paymentType,
            remarks: payload.remarks,
            status: payload.status,
          },
        });

        /* -------- Vendor Ledger ADJUSTMENT -------- */
        if (deltaNet !== 0) {
          const isDebitVendor = vendor.category === "DEBIT";

          const debit = isDebitVendor ? 0 : Math.max(deltaNet, 0);

          const credit = isDebitVendor ? Math.max(deltaNet, 0) : 0;

          const newBalance = isDebitVendor
            ? account.balance - deltaNet
            : account.balance + deltaNet;

          await tx.ledgerEntry.create({
            data: {
              accountId: account.id,
              entryType: "ADJUSTMENT",
              debit,
              credit,
              balanceAfter: newBalance,
              saleId: sale.id,
              invoiceId,
              remarks: "Sale edit adjustment",
            },
          });

          await tx.account.update({
            where: { id: account.id },
            data: { balance: newBalance },
          });

          account.balance = newBalance; // keep in-memory sync
        }

        totalNet += newNet;
        totalSell += newSell;
        totalProfit += newProfit;
      }

      /* -------- Update Invoice -------- */
      const updatedInvoice = await tx.salesInvoice.update({
        where: { id: invoiceId },
        data: {
          ...(saleDate ? { saleDate: new Date(saleDate) } : {}),
          totalNet,
          totalSell,
          totalProfit,
        },
      });

      return updatedInvoice;
    });

    res.json({
      success: true,
      message: "Sales invoice updated successfully",
      data: result,
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({
      success: false,
      error: err.message || "Failed to update sales",
    });
  }
});

router.delete("/:invoiceId", authenticate, async (req, res) => {
  const { invoiceId } = req.params;

  try {
    await prisma.$transaction(async (tx) => {
      const invoice = await tx.salesInvoice.findUnique({
        where: { id: invoiceId },
        include: {
          sales: true,
        },
      });

      if (!invoice) throw new Error("Invoice not found");

      for (const sale of invoice.sales) {
        /* ---------------- Vendor Reversal ---------------- */
        const vendor = await tx.vendor.findUnique({
          where: { id: sale.vendorId },
          include: { account: true },
        });
        if (!vendor || !vendor.account) continue;

        const isDebitVendor = vendor.category === "DEBIT";
        const amount = sale.netPrice;

        const newVendorBalance = isDebitVendor
          ? vendor.account.balance + amount
          : vendor.account.balance - amount;

        await tx.ledgerEntry.create({
          data: {
            accountId: vendor.account.id,
            entryType: "ADJUSTMENT",
            debit: isDebitVendor ? amount : 0,
            credit: isDebitVendor ? 0 : amount,
            balanceAfter: newVendorBalance,
            saleId: sale.id,
            invoiceId,
            remarks: "Invoice deleted – vendor reversal",
          },
        });

        await tx.account.update({
          where: { id: vendor.account.id },
          data: { balance: newVendorBalance },
        });

        /* ---------------- Customer Reversal (CREDIT sale only) ---------------- */
        if (
          String(sale.paymentType).toUpperCase() === "CREDIT" &&
          sale.customerId
        ) {
          const customer = await tx.customer.findUnique({
            where: { id: sale.customerId },
            include: { account: true },
          });

          if (!customer || !customer.account) continue;

          const newCustomerBalance = customer.account.balance - sale.sellPrice;

          await tx.ledgerEntry.create({
            data: {
              accountId: customer.account.id,
              entryType: "ADJUSTMENT",
              debit: 0,
              credit: sale.sellPrice,
              balanceAfter: newCustomerBalance,
              saleId: sale.id,
              invoiceId,
              remarks: "Invoice deleted – customer reversal",
            },
          });

          await tx.account.update({
            where: { id: customer.account.id },
            data: { balance: newCustomerBalance },
          });
        }
      }

      /* ---------------- Delete Business Records ---------------- */
      await tx.sale.deleteMany({
        where: { invoiceId },
      });

      await tx.salesInvoice.delete({
        where: { id: invoiceId },
      });
    });

    res.json({
      success: true,
      message: "Sales invoice deleted successfully",
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({
      success: false,
      error: err.message || "Failed to delete invoice",
    });
  }
});

export default router;
