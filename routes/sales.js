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

  /* ======================
     BASIC VALIDATION
  ====================== */
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
       1️⃣ READ / VALIDATION PHASE (NO TRANSACTION)
    ====================================================== */

    /* ---------- SALES VALIDATION ---------- */
    for (const s of sales) {
      const net = Number(s.netPrice);
      const sell = Number(s.sellPrice);
      const paid = Number(s.paidAmount || 0);

      if (Number.isNaN(net) || Number.isNaN(sell)) {
        throw new Error("netPrice and sellPrice must be numbers");
      }
      if (net < 0 || sell < 0) {
        throw new Error("netPrice/sellPrice cannot be negative");
      }
      if (paid < 0 || paid > sell) {
        throw new Error("Invalid paidAmount");
      }

      if (String(s.paymentType).toUpperCase() === "CREDIT" && !s.customerId) {
        throw new Error("customerId required for CREDIT sales");
      }
    }

    /* ---------- REFUND VALIDATION ---------- */
    for (const r of refunds) {
      if (!r.saleId) throw new Error("saleId required for refund");

      const amt = Number(r.refundableAmount);
      if (!amt || amt <= 0) {
        throw new Error("refundableAmount must be positive");
      }

      const fee = Number(r.refundFee || 0);
      const sc = Number(r.serviceCharges || 0);

      if (fee < 0 || sc < 0) {
        throw new Error("refundFee/serviceCharges cannot be negative");
      }
    }

    /* ---------- LOAD ORIGINAL SALES ---------- */
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

    /* ---------- PRELOAD REFUND TOTALS (FIX) ---------- */
    const refundSums = refundSaleIds.length
      ? await prisma.sale.groupBy({
          by: ["refundOfSaleId"],
          where: {
            isRefund: true,
            refundOfSaleId: { in: refundSaleIds },
          },
          _sum: { sellPrice: true },
        })
      : [];

    const refundSumMap = Object.fromEntries(
      refundSums.map((r) => [
        r.refundOfSaleId,
        Math.abs(Number(r._sum.sellPrice || 0)),
      ])
    );

    for (const r of refunds) {
      const orig = originalSaleMap[r.saleId];
      if (!orig) throw new Error(`Original sale not found: ${r.saleId}`);
      if (orig.isRefund) throw new Error("Cannot refund a refund");

      const alreadyRefunded = refundSumMap[r.saleId] || 0;

      if (
        Number(r.refundableAmount) >
        Number(orig.sellPrice) - alreadyRefunded
      ) {
        throw new Error("Refund exceeds remaining refundable amount");
      }
    }

    /* ---------- LOAD VENDORS & CUSTOMERS ---------- */
    const vendorIds = [
      ...new Set(sales.map((s) => s.vendorId).filter(Boolean)),
    ];
    const customerIds = [
      ...new Set(
        sales
          .filter((s) => String(s.paymentType).toUpperCase() === "CREDIT")
          .map((s) => s.customerId)
      ),
    ];

    const vendors = vendorIds.length
      ? await prisma.vendor.findMany({
          where: { id: { in: vendorIds } },
          include: { account: true },
        })
      : [];

    const customers = customerIds.length
      ? await prisma.customer.findMany({
          where: { id: { in: customerIds } },
          include: { account: true },
        })
      : [];

    const vendorMap = Object.fromEntries(vendors.map((v) => [v.id, v]));
    const customerMap = Object.fromEntries(customers.map((c) => [c.id, c]));

    /* ---------- DEBIT VENDOR BALANCE VALIDATION ---------- */
    for (const s of sales) {
      const vendor = vendorMap[s.vendorId];
      if (!vendor || vendor.category !== "DEBIT") continue;

      const net = Number(s.netPrice || 0);
      const balance = Number(vendor.account?.balance || 0);

      if (net > balance) {
        throw new Error(
          `Insufficient balance for vendor "${vendor.vendorName}". Available: ${balance}, Required: ${net}`
        );
      }
    }

    /* ======================================================
       2️⃣ WRITE PHASE (TRANSACTION)
    ====================================================== */

    const businessDate = saleDate ? new Date(saleDate) : new Date();

    const result = await prisma.$transaction(
      async (tx) => {
        const invoice = await tx.salesInvoice.create({
          data: {
            invoiceNo,
            saleDate: businessDate,
            userId: req.user.id,
          },
        });

        /* ---------- IN-MEMORY BALANCES ---------- */
        const balances = new Map();
        const initBal = (acc) =>
          acc &&
          !balances.has(acc.id) &&
          balances.set(acc.id, Number(acc.balance || 0));

        vendors.forEach((v) => initBal(v.account));
        customers.forEach((c) => initBal(c.account));
        originalSales.forEach((s) => {
          initBal(s.vendor?.account);
          initBal(s.customer?.account);
        });

        const getBal = (id) => balances.get(id) || 0;
        const setBal = (id, v) => balances.set(id, Number(v));

        let totalNet = 0;
        let totalSell = 0;
        let totalProfit = 0;

        /* ======================
           SALES
        ====================== */
        for (const s of sales) {
          const vendor = vendorMap[s.vendorId];
          const net = Number(s.netPrice);
          const sell = Number(s.sellPrice);
          const paid = Number(s.paidAmount || 0);
          const profit = sell - net;

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
              paidAmount: paid,
              paymentType: s.paymentType,
              paymentStatus:
                paid === sell ? "PAID" : paid > 0 ? "PARTIAL" : "DUE",
              status: "COMPLETED",
              isRefund: false,
            },
          });

          const isDebitVendor = vendor.category === "DEBIT";
          const vendorBalAfter =
            getBal(vendor.account.id) + (isDebitVendor ? net : -net);

          await tx.ledgerEntry.create({
            data: {
              accountId: vendor.account.id,
              entryType: "SALE",
              debit: isDebitVendor ? 0 : net,
              credit: isDebitVendor ? net : 0,
              balanceAfter: vendorBalAfter,
              transactionDate: businessDate,
              saleId: sale.id,
              invoiceId: invoice.id,
            },
          });

          await tx.account.update({
            where: { id: vendor.account.id },
            data: { balance: vendorBalAfter },
          });

          setBal(vendor.account.id, vendorBalAfter);

          if (String(s.paymentType).toUpperCase() === "CREDIT") {
            const cust = customerMap[s.customerId];
            const custBalAfter = getBal(cust.account.id) + sell;

            await tx.ledgerEntry.create({
              data: {
                accountId: cust.account.id,
                entryType: "SALE",
                debit: sell,
                credit: 0,
                balanceAfter: custBalAfter,
                transactionDate: businessDate,
                saleId: sale.id,
                invoiceId: invoice.id,
              },
            });

            await tx.account.update({
              where: { id: cust.account.id },
              data: { balance: custBalAfter },
            });

            setBal(cust.account.id, custBalAfter);
          }

          totalNet += net;
          totalSell += sell;
          totalProfit += profit;
        }

        /* ======================
           REFUNDS (UNCHANGED LOGIC)
        ====================== */
        for (const r of refunds) {
          const orig = originalSaleMap[r.saleId];

          const baseNet = Number(orig.netPrice);
          const baseSell = Number(orig.sellPrice);
          const fee = Number(r.refundFee || 0);
          const sc = Number(r.serviceCharges || 0);

          const customerRefund = baseNet - fee - sc;
          const vendorRefund = baseNet - fee;

          const refundSale = await tx.sale.create({
            data: {
              invoiceId: invoice.id,
              airlineId: orig.airlineId,
              vendorId: orig.vendorId,
              customerId: orig.customerId,
              documentNo: orig.documentNo,
              netPrice: -baseNet,
              sellPrice: -baseSell,
              profit: 0,
              paymentType: orig.paymentType,
              paidAmount: 0,
              paymentStatus: "PAID",
              status: "REFUNDED",
              isRefund: true,
              refundOfSaleId: orig.id,
            },
          });

          await tx.refund.create({
            data: {
              saleId: refundSale.id,
              originalAmount: baseNet,
              refundableAmount: customerRefund,
              refundFee: fee,
              serviceCharges: sc,
              remarks: r.remarks || null,
              refundDate: businessDate,
            },
          });

          /* ---- VENDOR REFUND LEDGER (FIXED) ---- */
          const isDebitVendor = orig.vendor.category === "DEBIT";
          const prevVendorBal = getBal(orig.vendor.account.id);

          // ✅ CREDIT entry for refund (ALWAYS)
          const vendorBalAfter = isDebitVendor
            ? prevVendorBal - vendorRefund // DEBIT vendor → subtract
            : prevVendorBal + vendorRefund; // CREDIT vendor → add

          await tx.ledgerEntry.create({
            data: {
              accountId: orig.vendor.account.id,
              entryType: "ADJUSTMENT",
              debit: 0,
              credit: vendorRefund,
              balanceAfter: vendorBalAfter,
              transactionDate: businessDate,
              saleId: refundSale.id,
              invoiceId: invoice.id,
            },
          });

          await tx.account.update({
            where: { id: orig.vendor.account.id },
            data: { balance: vendorBalAfter },
          });

          setBal(orig.vendor.account.id, vendorBalAfter);

          /* ---- CUSTOMER REFUND LEDGER (FIXED) ---- */
          if (
            String(orig.paymentType).toUpperCase() === "CREDIT" &&
            orig.customer?.account
          ) {
            const prevCustBal = getBal(orig.customer.account.id);

            // ✅ CREDIT customer, subtract balance
            const custBalAfter = prevCustBal - customerRefund;

            await tx.ledgerEntry.create({
              data: {
                accountId: orig.customer.account.id,
                entryType: "ADJUSTMENT",
                debit: 0,
                credit: customerRefund,
                balanceAfter: custBalAfter,
                transactionDate: businessDate,
                saleId: refundSale.id,
                invoiceId: invoice.id,
              },
            });

            await tx.account.update({
              where: { id: orig.customer.account.id },
              data: { balance: custBalAfter },
            });

            setBal(orig.customer.account.id, custBalAfter);
          }

          totalNet -= baseNet;
          totalSell -= baseSell;
        }

        await tx.salesInvoice.update({
          where: { id: invoice.id },
          data: { totalNet, totalSell, totalProfit },
        });

        return invoice;
      },
      { timeout: 15000 }
    );

    return res.status(201).json({
      success: true,
      message: "Sales & refunds processed successfully",
      data: result,
    });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ success: false, error: err.message });
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
