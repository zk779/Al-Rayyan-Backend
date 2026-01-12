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
    const invoices = await prisma.salesInvoice.findMany({
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
  const { invoiceNo, saleDate, sales } = req.body;

  if (!invoiceNo || !Array.isArray(sales) || sales.length === 0) {
    return res.status(400).json({
      success: false,
      error: "invoiceNo and sales array are required",
    });
  }

  try {
    /* ======================================================
       1️⃣ READ PHASE (NO TRANSACTION)
    ====================================================== */

    const vendorIds = [...new Set(sales.map((s) => s.vendorId))];
    const customerIds = [
      ...new Set(
        sales
          .filter((s) => String(s.paymentType).toUpperCase() === "CREDIT")
          .map((s) => s.customerId)
          .filter(Boolean)
      ),
    ];

    const vendors = await prisma.vendor.findMany({
      where: { id: { in: vendorIds } },
      include: { account: true },
    });

    const customers = await prisma.customer.findMany({
      where: { id: { in: customerIds } },
      include: { account: true },
    });

    const vendorMap = Object.fromEntries(vendors.map((v) => [v.id, v]));
    const customerMap = Object.fromEntries(customers.map((c) => [c.id, c]));

    // ✅ Pre-validation
    for (const s of sales) {
      const vendor = vendorMap[s.vendorId];
      if (!vendor) throw new Error("Vendor not found");

      if (
        vendor.category === "DEBIT" &&
        vendor.account.balance < Number(s.netPrice)
      ) {
        throw new Error(
          `Insufficient balance for debit vendor ${vendor.vendorName}`
        );
      }

      if (String(s.paymentType).toUpperCase() === "CREDIT" && s.customerId) {
        const customer = customerMap[s.customerId];
        if (!customer || !customer.isActive) {
          throw new Error("Invalid or inactive customer");
        }
      }
    }

    /* ======================================================
       2️⃣ WRITE PHASE (TRANSACTION)
    ====================================================== */

    const businessDate = saleDate ? new Date(saleDate) : new Date();

    const result = await prisma.$transaction(async (tx) => {
      const invoice = await tx.salesInvoice.create({
        data: {
          invoiceNo,
          saleDate: businessDate,
          userId: req.user.id,
        },
      });

      let totalNet = 0;
      let totalSell = 0;
      let totalProfit = 0;

      for (const s of sales) {
        const net = Number(s.netPrice);
        const sell = Number(s.sellPrice);
        const profit = sell - net;

        /* =======================
           💰 PAYMENT LOGIC
        ======================= */
        const paidAmount = Number(s.paidAmount || 0);

        if (paidAmount < 0) {
          throw new Error("Paid amount cannot be negative");
        }

        if (paidAmount > sell) {
          throw new Error("Paid amount cannot exceed sell price");
        }

        let paymentStatus = "DUE";
        if (paidAmount === sell) paymentStatus = "PAID";
        else if (paidAmount > 0) paymentStatus = "PARTIAL";

        const vendor = vendorMap[s.vendorId];
        const vendorAccount = vendor.account;

        const isDebitVendor = vendor.category === "DEBIT";
        const newVendorBalance = isDebitVendor
          ? vendorAccount.balance - net
          : vendorAccount.balance + net;

        /* =======================
           Create Sale
        ======================= */
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
            paymentStatus, // ✅ ADDED
            remarks: s.remarks || null,
            status: s.status,
          },
        });

        /* =======================
           Vendor Ledger Entry
        ======================= */
        await tx.ledgerEntry.create({
          data: {
            accountId: vendorAccount.id,
            entryType: "SALE",
            debit: isDebitVendor ? 0 : net,
            credit: isDebitVendor ? net : 0,
            balanceAfter: newVendorBalance,
            transactionDate: businessDate,
            saleId: sale.id,
            invoiceId: invoice.id,
          },
        });

        await tx.account.update({
          where: { id: vendorAccount.id },
          data: { balance: newVendorBalance },
        });

        vendorAccount.balance = newVendorBalance;

        /* =======================
           Customer Ledger Entry
        ======================= */
        if (String(s.paymentType).toUpperCase() === "CREDIT" && s.customerId) {
          const customer = customerMap[s.customerId];
          const customerAccount = customer.account;

          const newCustomerBalance = customerAccount.balance + sell;

          await tx.ledgerEntry.create({
            data: {
              accountId: customerAccount.id,
              entryType: "SALE",
              debit: sell,
              credit: 0,
              balanceAfter: newCustomerBalance,
              transactionDate: businessDate,
              saleId: sale.id,
              invoiceId: invoice.id,
            },
          });

          await tx.account.update({
            where: { id: customerAccount.id },
            data: { balance: newCustomerBalance },
          });

          customerAccount.balance = newCustomerBalance;
        }

        totalNet += net;
        totalSell += sell;
        totalProfit += profit;
      }

      await tx.salesInvoice.update({
        where: { id: invoice.id },
        data: { totalNet, totalSell, totalProfit },
      });

      return invoice;
    });

    res.status(201).json({
      success: true,
      message: "Sales created successfully",
      data: result,
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({
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
