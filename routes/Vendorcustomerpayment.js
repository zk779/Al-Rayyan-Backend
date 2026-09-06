import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { upload } from "../middleware/cloudinary.js";
import { generateNextPvNo } from "../utils/paymentCounter.js";

const router = express.Router();
const prisma = new PrismaClient();

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

router.post("/", authenticate, upload.single("attachment"), async (req, res) => {
  try {
    let {
      partyType,
      vendorId,
      customerId,
      method,
      bankId,
      bankSlipNo, // NEW — from bank receipt, optional, frontend-supplied
      amount,
      remarks,
      transactionDate,
      saleAllocations,
    } = req.body;

    const attachmentUrl = req.file ? req.file.path : null;

    if (!partyType || !method || !transactionDate)
      return res.status(400).json({ success: false, error: "partyType, method and transactionDate are required" });

    if (!["VENDOR", "CUSTOMER"].includes(partyType))
      return res.status(400).json({ success: false, error: "partyType must be either VENDOR or CUSTOMER" });

    if (!["CASH", "BANK_TRANSFER"].includes(method))
      return res.status(400).json({ success: false, error: "method must be either CASH or BANK_TRANSFER" });

    if (partyType === "VENDOR" && !vendorId)
      return res.status(400).json({ success: false, error: "vendorId is required when partyType is VENDOR" });

    if (partyType === "VENDOR" && customerId)
      return res.status(400).json({ success: false, error: "customerId must not be set when partyType is VENDOR" });

    if (partyType === "CUSTOMER" && !customerId)
      return res.status(400).json({ success: false, error: "customerId is required when partyType is CUSTOMER" });

    if (partyType === "CUSTOMER" && vendorId)
      return res.status(400).json({ success: false, error: "vendorId must not be set when partyType is CUSTOMER" });

    if (method === "BANK_TRANSFER" && !bankId)
      return res.status(400).json({ success: false, error: "bankId is required when method is BANK_TRANSFER" });

    if (method === "CASH" && bankId)
      return res.status(400).json({ success: false, error: "bankId must not be set when method is CASH" });

    const parsedDate = new Date(transactionDate);
    if (isNaN(parsedDate.getTime()))
      return res.status(400).json({ success: false, error: "transactionDate must be a valid date" });

    let allocations = [];
    if (partyType === "CUSTOMER") {
      if (typeof saleAllocations === "string") {
        try {
          allocations = JSON.parse(saleAllocations);
        } catch {
          return res.status(400).json({ success: false, error: "saleAllocations must be valid JSON" });
        }
      } else if (Array.isArray(saleAllocations)) {
        allocations = saleAllocations;
      }

      if (!Array.isArray(allocations) || allocations.length === 0)
        return res.status(400).json({ success: false, error: "saleAllocations must be a non-empty array of { saleId, amount } for customer payments" });

      const seen = new Set();
      for (const a of allocations) {
        if (!a.saleId || a.amount === undefined)
          return res.status(400).json({ success: false, error: "Each saleAllocations entry requires saleId and amount" });

        a.amount = Number(a.amount);
        if (isNaN(a.amount) || a.amount <= 0)
          return res.status(400).json({ success: false, error: `Invalid amount for sale ${a.saleId}` });

        if (seen.has(a.saleId))
          return res.status(400).json({ success: false, error: `Duplicate saleId ${a.saleId} in saleAllocations` });
        seen.add(a.saleId);
      }

      const allocationTotal = allocations.reduce((sum, a) => sum + a.amount, 0);

      if (amount !== undefined && amount !== null && amount !== "") {
        if (Number(amount) !== allocationTotal)
          return res.status(400).json({ success: false, error: `amount (${Number(amount)}) must equal the sum of saleAllocations (${allocationTotal})` });
      }

      amount = allocationTotal;
    } else {
      if (amount === undefined)
        return res.status(400).json({ success: false, error: "amount is required" });
      amount = Number(amount);
    }

    if (isNaN(amount) || amount <= 0)
      return res.status(400).json({ success: false, error: "amount must be a number greater than 0" });

    let vendor = null;
    let customer = null;

    if (partyType === "VENDOR") {
      vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, include: { account: true } });
      if (!vendor) return res.status(404).json({ success: false, error: "Vendor not found" });
      if (!vendor.status) return res.status(400).json({ success: false, error: "Vendor is inactive" });
    } else {
      customer = await prisma.customer.findUnique({ where: { id: customerId }, include: { account: true } });
      if (!customer) return res.status(404).json({ success: false, error: "Customer not found" });
      if (!customer.isActive) return res.status(400).json({ success: false, error: "Customer is inactive" });
    }

    let salesById = new Map();
    if (partyType === "CUSTOMER") {
      const saleIds = allocations.map((a) => a.saleId);
      const sales = await prisma.sale.findMany({
        where: { id: { in: saleIds } },
        include: { invoice: { select: { invoiceNo: true } } },
      });

      salesById = new Map(sales.map((s) => [s.id, s]));

      for (const a of allocations) {
        const sale = salesById.get(a.saleId);

        if (!sale) return res.status(404).json({ success: false, error: `Sale ${a.saleId} not found` });
        if (sale.customerId !== customerId)
          return res.status(400).json({ success: false, error: `Sale ${a.saleId} does not belong to customer ${customerId}` });
        if (!["DUE", "PARTIAL"].includes(sale.paymentStatus))
          return res.status(400).json({ success: false, error: `Sale ${a.saleId} is already ${sale.paymentStatus} and cannot accept further payment` });

        const remainingDue = sale.sellPrice - sale.paidAmount;
        if (a.amount > remainingDue)
          return res.status(400).json({ success: false, error: `Payment amount (${a.amount}) for sale ${a.saleId} exceeds its remaining due (${remainingDue})` });
      }
    }

    let bank = null;
    if (method === "BANK_TRANSFER") {
      bank = await prisma.bank.findUnique({ where: { id: bankId }, include: { account: true } });
      if (!bank) return res.status(404).json({ success: false, error: "Bank not found" });
      if (!bank.isActive) return res.status(400).json({ success: false, error: "Bank account is inactive" });
      // if (partyType === "VENDOR" && amount > bank.account.balance)
      //   return res.status(400).json({ success: false, error: `Insufficient bank balance. Trying to pay ${amount} but bank only has ${bank.account.balance} available.` });
    }

    let cashAccount = null;
    if (method === "CASH") {
      cashAccount = await prisma.account.findFirst({ where: { type: "CASH" } });
      // if (partyType === "VENDOR" && cashAccount && amount > cashAccount.balance)
      //   return res.status(400).json({ success: false, error: `Insufficient cash balance. Trying to pay ${amount} but cash account only has ${cashAccount.balance} available.` });
    }

    const partyAccount = partyType === "VENDOR" ? vendor.account : customer.account;
    const currentBalance = partyAccount.balance;

    const singleAllocationSaleId =
      partyType === "CUSTOMER" && allocations.length === 1 ? allocations[0].saleId : null;

    let partyLegDebit = 0;
    let partyLegCredit = 0;
    let partyBalanceDelta = 0;

    if (partyType === "VENDOR" && vendor.category === "DEBIT") {
      if (amount > currentBalance)
        return res.status(400).json({ success: false, error: `Payment amount (${amount}) exceeds vendor's outstanding balance (${currentBalance}).` });
      partyLegDebit = amount;
      partyBalanceDelta = -amount;
    } else if (partyType === "VENDOR" && vendor.category === "CREDIT") {
      partyLegDebit = amount;
      partyBalanceDelta = amount;
    } else if (partyType === "CUSTOMER") {
      if (amount > currentBalance)
        return res.status(400).json({ success: false, error: `Payment amount (${amount}) exceeds customer's outstanding balance (${currentBalance}).` });
      partyLegCredit = amount;
      partyBalanceDelta = -amount;
    }

    let bankLegDebit = 0;
    let bankLegCredit = 0;
    let bankBalanceDelta = 0;

    if (method === "BANK_TRANSFER") {
      if (partyType === "VENDOR") {
        bankLegDebit = amount;
        bankBalanceDelta = -amount;
      } else {
        bankLegCredit = amount;
        bankBalanceDelta = amount;
      }
    }

    let cashLegDebit = 0;
    let cashLegCredit = 0;
    let cashBalanceDelta = 0;

    if (method === "CASH") {
      if (partyType === "VENDOR") {
        cashLegDebit = amount;
        cashBalanceDelta = -amount;
      } else {
        cashLegCredit = amount;
        cashBalanceDelta = amount;
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const getCashAccount = async () => {
        if (cashAccount) return cashAccount;
        cashAccount = await tx.account.findFirst({ where: { type: "CASH" } });
        if (!cashAccount) {
          cashAccount = await tx.account.create({ data: { name: "Cash Account", type: "CASH", balance: 0 } });
        }
        return cashAccount;
      };

      const cash = method === "CASH" ? await getCashAccount() : null;

      // NEW — sequential PV number, scoped to the user's branch + year
      const pvNo = await generateNextPvNo(tx, req.user.branchCode, parsedDate);

      const payment = await tx.vendorCustomerPayment.create({
        data: {
          partyType,
          vendorId: partyType === "VENDOR" ? vendorId : null,
          customerId: partyType === "CUSTOMER" ? customerId : null,
          saleId: singleAllocationSaleId,
          method,
          amount,
          bankId: method === "BANK_TRANSFER" ? bankId : null,
          accountId: method === "CASH" ? cash.id : null,
          attachmentUrl: attachmentUrl,
          remarks: remarks ?? null,
          transactionDate: parsedDate,
          pvNo,                          // NEW
          bankSlipNo: bankSlipNo ?? null, // NEW
          createdById: req.user.id,       // NEW
          branchId: req.user.branchId,    // NEW
        },
      });

      if (partyType === "CUSTOMER") {
        for (const a of allocations) {
          const sale = salesById.get(a.saleId);
          const invoiceNo = sale.invoice?.invoiceNo ?? "N/A";
          const entryRemarks = `Payment against Invoice ${invoiceNo} (Sale ${a.saleId})${remarks ? ` — ${remarks}` : ""}`;

          await tx.ledgerEntry.create({
            data: {
              accountId: partyAccount.id,
              entryType: "PAYMENT",
              debit: 0,
              credit: a.amount,
              saleId: a.saleId,
              vendorCustomerPaymentId: payment.id,
              transactionDate: parsedDate,
              remarks: entryRemarks,
            },
          });

          if (method === "CASH") {
            await tx.ledgerEntry.create({
              data: {
                accountId: cash.id,
                entryType: "PAYMENT",
                debit: 0,
                credit: a.amount,
                saleId: a.saleId,
                vendorCustomerPaymentId: payment.id,
                transactionDate: parsedDate,
                remarks: `Cash received against Invoice ${invoiceNo} (Sale ${a.saleId})${remarks ? ` — ${remarks}` : ""}`,
              },
            });
          }

          const newPaidAmount = sale.paidAmount + a.amount;
          const newStatus = newPaidAmount >= sale.sellPrice ? "PAID" : "PARTIAL";

          await tx.sale.update({
            where: { id: a.saleId },
            data: { paidAmount: newPaidAmount, paymentStatus: newStatus },
          });
        }
      } else {
        await tx.ledgerEntry.create({
          data: {
            accountId: partyAccount.id,
            entryType: "PAYMENT",
            debit: partyLegDebit,
            credit: partyLegCredit,
            vendorCustomerPaymentId: payment.id,
            transactionDate: parsedDate,
            remarks: remarks ?? null,
          },
        });

        if (method === "CASH") {
          await tx.ledgerEntry.create({
            data: {
              accountId: cash.id,
              entryType: "PAYMENT",
              debit: cashLegDebit,
              credit: cashLegCredit,
              vendorCustomerPaymentId: payment.id,
              transactionDate: parsedDate,
              remarks: remarks ?? null,
            },
          });
        }
      }

      await tx.account.update({
        where: { id: partyAccount.id },
        data: { balance: { increment: partyBalanceDelta } },
      });

      if (method === "BANK_TRANSFER") {
        await tx.account.update({
          where: { id: bank.account.id },
          data: { balance: { increment: bankBalanceDelta } },
        });

        await tx.ledgerEntry.create({
          data: {
            accountId: bank.account.id,
            entryType: "PAYMENT",
            debit: bankLegDebit,
            credit: bankLegCredit,
            vendorCustomerPaymentId: payment.id,
            transactionDate: parsedDate,
            remarks: remarks ?? null,
          },
        });
      }

      if (method === "CASH") {
        await tx.account.update({
          where: { id: cash.id },
          data: { balance: { increment: cashBalanceDelta } },
        });
      }

      return payment;
    }, { timeout: 30000, maxWait: 10000 });

    const fullPayment = await prisma.vendorCustomerPayment.findUnique({
      where: { id: result.id },
      include: {
        vendor: { select: { id: true, vendorName: true, category: true } },
        customer: { select: { id: true, customerName: true } },
        sale: { select: { id: true, documentNo: true, invoice: { select: { id: true, invoiceNo: true } } } },
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        account: { select: { id: true, name: true, type: true, balance: true } },
        createdBy: { select: { id: true, fullName: true } }, // NEW
        branch: { select: { id: true, name: true, code: true } }, // NEW
        ledgerEntries: true,
      },
    });

    res.status(201).json({ success: true, data: fullPayment });
  } catch (err) {
    console.error("Error creating vendor/customer payment:", err);
    res.status(500).json({ success: false, error: "Failed to create payment" });
  }
});

// ---- GET ALL ----
router.get("/", async (req, res) => {
  try {
    const {
      partyType,
      vendorId,
      customerId,
      saleId,
      method,
      branchId, // NEW
      dateFrom,
      dateTo,
      order,
      search,
    } = req.query;

    const filters = [];

    if (partyType) {
      filters.push({ partyType: String(partyType).toUpperCase() });
    }

    if (vendorId) {
      filters.push({ vendorId });
    }

    if (customerId) {
      filters.push({ customerId });
    }

    if (saleId) {
      filters.push({ saleId });
    }

    if (method) {
      filters.push({ method: String(method).toUpperCase() });
    }

    if (branchId) { // NEW
      filters.push({ branchId });
    }

    if (dateFrom || dateTo) {
      const dateFilter = {};

      if (dateFrom) {
        const from = new Date(dateFrom);
        if (!isNaN(from.getTime())) dateFilter.gte = from;
      }

      if (dateTo) {
        const to = new Date(dateTo);
        if (!isNaN(to.getTime())) {
          to.setHours(23, 59, 59, 999);
          dateFilter.lte = to;
        }
      }

      if (Object.keys(dateFilter).length > 0) {
        filters.push({ transactionDate: dateFilter });
      }
    }

    // Search across: the payment's own remarks/pvNo/bankSlipNo, the
    // vendor/customer name, or the linked sale's documentNo/invoiceNo (only
    // present for single-sale payments — walk-in or otherwise).
    if (search) {
      filters.push({
        OR: [
          { remarks: { contains: search, mode: "insensitive" } },
          { pvNo: { contains: search, mode: "insensitive" } }, // NEW
          { bankSlipNo: { contains: search, mode: "insensitive" } }, // NEW
          { vendor: { vendorName: { contains: search, mode: "insensitive" } } },
          { customer: { customerName: { contains: search, mode: "insensitive" } } },
          { sale: { documentNo: { contains: search, mode: "insensitive" } } },
          { sale: { invoice: { invoiceNo: { contains: search, mode: "insensitive" } } } },
        ],
      });
    }

    const where = filters.length > 0 ? { AND: filters } : {};
    const sortDirection = String(order || "").toLowerCase() === "asc" ? "asc" : "desc";

    const payments = await prisma.vendorCustomerPayment.findMany({
      where,
      include: {
        vendor: { select: { id: true, vendorName: true, category: true } },
        customer: { select: { id: true, customerName: true } },
        sale: {
          select: {
            id: true,
            documentNo: true,
            paxName: true,
            invoice: { select: { id: true, invoiceNo: true } },
          },
        },
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        account: { select: { id: true, name: true, type: true, balance: true } },
        createdBy: { select: { id: true, fullName: true } }, // NEW
        branch: { select: { id: true, name: true, code: true } }, // NEW
        ledgerEntries: true,
      },
      orderBy: { transactionDate: sortDirection },
    });

    const data = payments.map((p) => ({
      ...p,
      isWalkIn: !p.customerId && !p.vendorId && !!p.saleId,
    }));

    res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("Error fetching payments:", err);
    res.status(500).json({ success: false, error: "Failed to fetch payments" });
  }
});


// ---- GET BY ID ----
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const payment = await prisma.vendorCustomerPayment.findUnique({
      where: { id },
      include: {
        vendor: { select: { id: true, vendorName: true, category: true } },
        customer: { select: { id: true, customerName: true } },
        sale: {
          select: {
            id: true,
            documentNo: true,
            paxName: true,
            invoice: { select: { id: true, invoiceNo: true } },
          },
        },
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        account: { select: { id: true, name: true, type: true, balance: true } },
        createdBy: { select: { id: true, fullName: true } }, // NEW
        branch: { select: { id: true, name: true, code: true } }, // NEW
        ledgerEntries: true,
      },
    });

    if (!payment)
      return res.status(404).json({ success: false, error: "Payment not found" });

    res.status(200).json({
      success: true,
      data: {
        ...payment,
        isWalkIn: !payment.customerId && !payment.vendorId && !!payment.saleId,
      },
    });
  } catch (err) {
    console.error("Error fetching payment:", err);
    res.status(500).json({ success: false, error: "Failed to fetch payment" });
  }
});


router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let {
      amount,
      attachmentUrl,
      remarks,
      transactionDate,
      method,
      bankId,
      bankSlipNo,
      saleAllocations, // Only applies to MULTI-SALE customer payments (JSON
    } = req.body;

    // ---- Load existing payment ----
    const existing = await prisma.vendorCustomerPayment.findUnique({
      where: { id },
      include: { ledgerEntries: true },
    });

    if (!existing)
      return res.status(404).json({ success: false, error: "Payment not found" });

    const partyType = existing.partyType;

    const isMultiSaleCustomer = partyType === "CUSTOMER" && !existing.saleId;
    const isSingleSalePayment = partyType === "CUSTOMER" && !!existing.saleId;

    if (isSingleSalePayment && saleAllocations !== undefined && saleAllocations !== null) {
      return res.status(400).json({
        success: false,
        error: "saleAllocations does not apply to a single-sale payment — use amount instead",
      });
    }
    let singleSaleAllocationAmount = null;
    if (isSingleSalePayment && saleAllocations !== undefined && saleAllocations !== null) {
      let parsedAllocations;
      if (typeof saleAllocations === "string") {
        try {
          parsedAllocations = JSON.parse(saleAllocations);
        } catch {
          return res.status(400).json({ success: false, error: "saleAllocations must be valid JSON" });
        }
      } else if (Array.isArray(saleAllocations)) {
        parsedAllocations = saleAllocations;
      }

      if (!Array.isArray(parsedAllocations) || parsedAllocations.length !== 1) {
        return res.status(400).json({
          success: false,
          error:
            "A single-sale payment only accepts a single saleAllocations entry (for its own sale) — use amount directly instead.",
        });
      }

      const [alloc] = parsedAllocations;
      if (!alloc.saleId || alloc.saleId !== existing.saleId) {
        return res.status(400).json({
          success: false,
          error: "Cannot re-point a single-sale payment to a different sale via edit.",
        });
      }

      const allocAmount = Number(alloc.amount);
      if (isNaN(allocAmount) || allocAmount <= 0) {
        return res.status(400).json({ success: false, error: `Invalid amount for sale ${alloc.saleId}` });
      }

      singleSaleAllocationAmount = allocAmount;
    }

    // ---- Parse saleAllocations (multi-sale CUSTOMER only) ----
    let allocations = null;
    if (isMultiSaleCustomer && saleAllocations !== undefined && saleAllocations !== null) {
      if (typeof saleAllocations === "string") {
        try {
          allocations = JSON.parse(saleAllocations);
        } catch {
          return res.status(400).json({
            success: false,
            error: "saleAllocations must be valid JSON",
          });
        }
      } else if (Array.isArray(saleAllocations)) {
        allocations = saleAllocations;
      }

      if (!Array.isArray(allocations) || allocations.length === 0)
        return res.status(400).json({
          success: false,
          error: "saleAllocations must be a non-empty array of { saleId, amount }",
        });

      const seen = new Set();
      for (const a of allocations) {
        if (!a.saleId || a.amount === undefined)
          return res.status(400).json({
            success: false,
            error: "Each saleAllocations entry requires saleId and amount",
          });

        a.amount = Number(a.amount);
        if (isNaN(a.amount) || a.amount <= 0)
          return res.status(400).json({
            success: false,
            error: `Invalid amount for sale ${a.saleId}`,
          });

        if (seen.has(a.saleId))
          return res.status(400).json({
            success: false,
            error: `Duplicate saleId ${a.saleId} in saleAllocations`,
          });
        seen.add(a.saleId);
      }
    }

    // ---- Determine newAmount ----
    let newAmount;

    if (isMultiSaleCustomer && allocations) {
      const allocationTotal = allocations.reduce((sum, a) => sum + a.amount, 0);

      if (amount !== undefined && amount !== null && Number(amount) !== allocationTotal)
        return res.status(400).json({
          success: false,
          error: `amount (${Number(amount)}) must equal the sum of saleAllocations (${allocationTotal})`,
        });

      newAmount = allocationTotal;
    } else if (isMultiSaleCustomer && !allocations) {
      if (amount !== undefined && amount !== null && Number(amount) !== existing.amount)
        return res.status(400).json({
          success: false,
          error:
            "saleAllocations is required to change the amount of a customer payment linked to invoices",
        });
      newAmount = existing.amount;
    } else if (isSingleSalePayment) {
      if (singleSaleAllocationAmount !== null) {
        if (amount !== undefined && amount !== null && Number(amount) !== singleSaleAllocationAmount)
          return res.status(400).json({
            success: false,
            error: `amount (${Number(amount)}) must equal the saleAllocations amount (${singleSaleAllocationAmount})`,
          });
        newAmount = singleSaleAllocationAmount;
      } else if (amount !== undefined && amount !== null) {
        newAmount = Number(amount);
        if (isNaN(newAmount) || newAmount <= 0)
          return res.status(400).json({
            success: false,
            error: "amount must be a number greater than 0",
          });
      } else {
        newAmount = existing.amount;
      }
    } else {
      // VENDOR — unchanged behavior
      if (amount !== undefined && (typeof amount !== "number" || amount <= 0))
        return res.status(400).json({
          success: false,
          error: "amount must be a number greater than 0",
        });
      newAmount = amount ?? existing.amount;
    }

    if (transactionDate !== undefined) {
      const parsed = new Date(transactionDate);
      if (isNaN(parsed.getTime()))
        return res.status(400).json({ success: false, error: "transactionDate must be a valid date" });
    }

    // ---- method / bankId consistency ----
    const newMethod = method ?? existing.method;

    const newBankId =
      newMethod === "BANK_TRANSFER"
        ? (bankId !== undefined ? bankId : existing.bankId)
        : null;

    if (newMethod === "BANK_TRANSFER" && !newBankId)
      return res.status(400).json({ success: false, error: "bankId is required when method is BANK_TRANSFER" });

    if (newMethod === "CASH" && newBankId)
      return res.status(400).json({ success: false, error: "bankId must not be set when method is CASH" });

    const parsedDate = transactionDate ? new Date(transactionDate) : existing.transactionDate;
    let partyAccount = null;
    let vendor = null;
    let customer = null;
    let sale = null; // only populated for single-sale payments

    if (partyType === "VENDOR") {
      vendor = await prisma.vendor.findUnique({
        where: { id: existing.vendorId },
        include: { account: true },
      });
      partyAccount = vendor.account;
    } else if (isMultiSaleCustomer) {
      customer = await prisma.customer.findUnique({
        where: { id: existing.customerId },
        include: { account: true },
      });
      partyAccount = customer.account;
    } else if (isSingleSalePayment) {
      sale = await prisma.sale.findUnique({
        where: { id: existing.saleId },
        include: {
          invoice: { select: { invoiceNo: true } },
          customer: { include: { account: true } },
          refunds: { select: { netRefundToCustomer: true } },
        },
      });

      if (!sale)
        return res.status(404).json({ success: false, error: "Linked sale not found" });

      if (sale.customerId && sale.customer) {
        customer = sale.customer;
        partyAccount = sale.customer.account;
      }
      // else: walk-in — partyAccount stays null, no customer leg at all
    }

    let singleSaleCtx = null;
    if (isSingleSalePayment) {
      const refund = sale.refunds && sale.refunds.length > 0 ? sale.refunds[0] : null;
      const netRefundToCustomer = refund ? Number(refund.netRefundToCustomer || 0) : 0;
      const paidAmountAfterReversal = (sale.paidAmount || 0) - existing.amount;
      const remainingDueAfterReversal = sale.sellPrice - paidAmountAfterReversal - netRefundToCustomer;

      if (newAmount > remainingDueAfterReversal + 0.01)
        return res.status(400).json({
          success: false,
          error: `Payment amount (${newAmount}) exceeds the sale's remaining due (${remainingDueAfterReversal.toFixed(2)})`,
        });

      singleSaleCtx = { netRefundToCustomer, paidAmountAfterReversal };
    }

    // ---- Load new bank if method is BANK_TRANSFER ----
    let newBank = null;
    if (newMethod === "BANK_TRANSFER") {
      newBank = await prisma.bank.findUnique({
        where: { id: newBankId },
        include: { account: true },
      });

      if (!newBank)
        return res.status(404).json({ success: false, error: "Bank not found" });

      if (!newBank.isActive)
        return res.status(400).json({ success: false, error: "Bank account is inactive" });
    }

    // ---- Load new cash account if method is CASH (get, not yet create) ----
    let newCashAccount = null;
    if (newMethod === "CASH") {
      newCashAccount = await prisma.account.findFirst({ where: { type: "CASH" } });
    }

    // ---- Find old bank account/entry (needed only to reverse the BANK leg) ----
    let oldBankAccount = null;
    let oldBankEntry = null;
    if (existing.method === "BANK_TRANSFER" && existing.bankId) {
      const oldBank = await prisma.bank.findUnique({
        where: { id: existing.bankId },
        include: { account: true },
      });
      oldBankAccount = oldBank?.account ?? null;
      oldBankEntry = existing.ledgerEntries.find((e) => e.accountId === oldBankAccount?.id);
    }

    // ---- Find old cash account/entries (needed only to reverse the CASH leg) ----
    // Note: for CUSTOMER payments cash may be split across multiple entries
    // (one per sale for multi-sale, or a single tagged entry for single-sale),
    // so we sum debit-credit across all of them for reversal.
    let oldCashAccount = null;
    let oldCashDelta = 0;
    if (existing.method === "CASH" && existing.accountId) {
      oldCashAccount = await prisma.account.findUnique({ where: { id: existing.accountId } });
      const oldCashEntries = existing.ledgerEntries.filter((e) => e.accountId === existing.accountId);
      oldCashDelta = oldCashEntries.reduce((sum, e) => sum + (e.debit - e.credit), 0);
    }

    // ---- Multi-sale CUSTOMER: work out the per-sale reversal + reallocation plan ----
    const oldAllocationMap = new Map();
    if (isMultiSaleCustomer) {
      existing.ledgerEntries.forEach((e) => {
        // Only count the PARTY-side entries (i.e. against the customer's own
        // account), not the mirrored bank/cash-side entries, to avoid
        // double-counting saleId contributions.
        if (e.saleId && e.accountId === partyAccount.id) {
          oldAllocationMap.set(e.saleId, (oldAllocationMap.get(e.saleId) || 0) + e.credit);
        }
      });
    }

    const unionSaleIds = new Set([
      ...oldAllocationMap.keys(),
      ...(allocations ? allocations.map((a) => a.saleId) : []),
    ]);
    let multiSaleFinalSaleId = null;
    if (isMultiSaleCustomer) {
      const finalSaleIds = allocations
        ? [...new Set(allocations.map((a) => a.saleId))]
        : [...oldAllocationMap.keys()];
      multiSaleFinalSaleId = finalSaleIds.length === 1 ? finalSaleIds[0] : null;
    }

    let salesById = new Map();
    let saleFinalUpdates = [];

    if (isMultiSaleCustomer && unionSaleIds.size > 0) {
      const saleList = await prisma.sale.findMany({
        where: { id: { in: [...unionSaleIds] } },
        include: { invoice: { select: { invoiceNo: true } } },
      });
      salesById = new Map(saleList.map((s) => [s.id, s]));

      for (const saleId of unionSaleIds) {
        const s = salesById.get(saleId);
        if (!s)
          return res.status(404).json({ success: false, error: `Sale ${saleId} not found` });
        if (s.customerId !== existing.customerId)
          return res.status(400).json({
            success: false,
            error: `Sale ${saleId} does not belong to this payment's customer`,
          });
      }

      if (allocations) {
        const newAllocationMap = new Map(allocations.map((a) => [a.saleId, a.amount]));

        for (const saleId of unionSaleIds) {
          const s = salesById.get(saleId);
          const oldAmt = oldAllocationMap.get(saleId) || 0;
          const newAmt = newAllocationMap.get(saleId) || 0;

          const working = s.paidAmount - oldAmt + newAmt;

          if (working > s.sellPrice + 0.01)
            return res.status(400).json({
              success: false,
              error: `Allocation (${newAmt}) for sale ${saleId} would exceed its sell price (remaining after reversing this payment's old contribution: ${(s.sellPrice - (s.paidAmount - oldAmt)).toFixed(2)})`,
            });

          const clamped = Math.max(0, working);
          const newStatus =
            clamped <= 0 ? "DUE" : clamped >= s.sellPrice ? "PAID" : "PARTIAL";

          saleFinalUpdates.push({ saleId, newPaidAmount: clamped, newStatus });
        }
      }
    }

    // ---- Recompute party leg direction/balance delta (net shift old -> new amount) ----
    let partyLegDebit = 0;
    let partyLegCredit = 0;
    let partyBalanceDelta = 0;

    if (partyType === "VENDOR" && vendor.category === "DEBIT") {
      const restoredBalance = partyAccount.balance + existing.amount;
      if (newAmount > restoredBalance)
        return res.status(400).json({
          success: false,
          error: `Payment amount (${newAmount}) exceeds vendor's outstanding balance (${restoredBalance}).`,
        });

      partyLegDebit = newAmount;
      partyBalanceDelta = -(newAmount - existing.amount);
    } else if (partyType === "VENDOR" && vendor.category === "CREDIT") {
      partyLegDebit = newAmount;
      partyBalanceDelta = newAmount - existing.amount;
    } else if (isMultiSaleCustomer) {
      const restoredBalance = partyAccount.balance + existing.amount;
      if (newAmount > restoredBalance)
        return res.status(400).json({
          success: false,
          error: `Payment amount (${newAmount}) exceeds customer's outstanding balance (${restoredBalance}).`,
        });

      partyLegCredit = newAmount;
      partyBalanceDelta = -(newAmount - existing.amount);
    } else if (isSingleSalePayment && partyAccount) {
      // Single-sale payment WITH a customer attached — same direction as
      // the multi-sale case, just for exactly one sale.
      const restoredBalance = partyAccount.balance + existing.amount;
      if (newAmount > restoredBalance)
        return res.status(400).json({
          success: false,
          error: `Payment amount (${newAmount}) exceeds customer's outstanding balance (${restoredBalance}).`,
        });

      partyLegCredit = newAmount;
      partyBalanceDelta = -(newAmount - existing.amount);
    }
    // else: isSingleSalePayment && !partyAccount (walk-in) — no party leg at
    // all, all three values correctly stay at their 0 defaults.

    // ---- Bank leg ----
    let bankLegDebit = 0;
    let bankLegCredit = 0;

    if (newMethod === "BANK_TRANSFER") {
      if (partyType === "VENDOR") {
        const restoredBankBalance =
          oldBankAccount?.id === newBank.account.id
            ? newBank.account.balance + existing.amount
            : newBank.account.balance;

        // if (newAmount > restoredBankBalance)
        //   return res.status(400).json({
        //     success: false,
        //     error: `Insufficient bank balance. Trying to pay ${newAmount} but bank only has ${restoredBankBalance} available.`,
        //   });

        bankLegDebit = newAmount;
      } else {
        bankLegCredit = newAmount;
      }
    }

    // ---- Cash leg ----
    // VENDOR + CASH -> debit cash (money out), single combined entry
    // CUSTOMER (any flavor) + CASH -> credit cash (money in)
    let cashLegDebit = 0;
    let cashLegCredit = 0;

    if (newMethod === "CASH") {
      if (partyType === "VENDOR") {
        const restoredCashBalance = newCashAccount
          ? (oldCashAccount?.id === newCashAccount.id
            ? newCashAccount.balance + existing.amount
            : newCashAccount.balance)
          : 0;

        // if (newAmount > restoredCashBalance)
        //   return res.status(400).json({
        //     success: false,
        //     error: `Insufficient cash balance. Trying to pay ${newAmount} but cash account only has ${restoredCashBalance} available.`,
        //   });
        cashLegDebit = newAmount;
      } else {
        cashLegCredit = newAmount;
      }
    }

    // ---- Persist atomically ----
    const result = await prisma.$transaction(async (tx) => {
      // Get-or-create the singleton cash account inside the transaction
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

      const cash = newMethod === "CASH" ? await getCashAccount() : null;

      // 1. Reverse old bank balance if old method was BANK_TRANSFER
      if (existing.method === "BANK_TRANSFER" && oldBankAccount) {
        const oldBankDelta = (oldBankEntry?.debit ?? 0) - (oldBankEntry?.credit ?? 0);
        await tx.account.update({
          where: { id: oldBankAccount.id },
          data: { balance: { increment: oldBankDelta } },
        });
      }

      // 1b. Reverse old cash balance if old method was CASH
      if (existing.method === "CASH" && oldCashAccount) {
        await tx.account.update({
          where: { id: oldCashAccount.id },
          data: { balance: { increment: oldCashDelta } },
        });
      }

      // 2. Delete old ledger entries
      await tx.ledgerEntry.deleteMany({ where: { vendorCustomerPaymentId: id } });
      const updated = await tx.vendorCustomerPayment.update({
        where: { id },
        data: {
          amount: newAmount,
          method: newMethod,
          bankId: newMethod === "BANK_TRANSFER" ? newBankId : null,
          accountId: newMethod === "CASH" ? cash.id : null,
          attachmentUrl: attachmentUrl ?? existing.attachmentUrl,
          remarks: remarks ?? existing.remarks,
          bankSlipNo: bankSlipNo ?? existing.bankSlipNo,
          transactionDate: parsedDate,
          ...(isMultiSaleCustomer ? { saleId: multiSaleFinalSaleId } : {}),
        },
      });

      // 4. Party leg(s) + sale status updates
      if (isMultiSaleCustomer && allocations) {
        for (const a of allocations) {
          const s = salesById.get(a.saleId);
          const invoiceNo = s.invoice?.invoiceNo ?? "N/A";
          const entryRemarks = `Payment against Invoice ${invoiceNo} (Sale ${a.saleId})${(remarks ?? existing.remarks) ? ` — ${remarks ?? existing.remarks}` : ""
            }`;

          await tx.ledgerEntry.create({
            data: {
              accountId: partyAccount.id,
              entryType: "PAYMENT",
              debit: 0,
              credit: a.amount,
              saleId: a.saleId,
              vendorCustomerPaymentId: id,
              transactionDate: parsedDate,
              remarks: entryRemarks,
            },
          });

          // ---- Cash leg per allocation (CUSTOMER + CASH only) ----
          if (newMethod === "CASH") {
            await tx.ledgerEntry.create({
              data: {
                accountId: cash.id,
                entryType: "PAYMENT",
                debit: 0,
                credit: a.amount,
                saleId: a.saleId,
                vendorCustomerPaymentId: id,
                transactionDate: parsedDate,
                remarks: `Cash received against Invoice ${invoiceNo} (Sale ${a.saleId})${(remarks ?? existing.remarks) ? ` — ${remarks ?? existing.remarks}` : ""
                  }`,
              },
            });
          }
        }

        for (const u of saleFinalUpdates) {
          await tx.sale.update({
            where: { id: u.saleId },
            data: { paidAmount: u.newPaidAmount, paymentStatus: u.newStatus },
          });
        }
      } else if (isMultiSaleCustomer && !allocations) {
        // No change to the split — recreate the same per-sale entries
        for (const [saleId, oldAmt] of oldAllocationMap.entries()) {
          const s = salesById.get(saleId);
          const invoiceNo = s?.invoice?.invoiceNo ?? "N/A";
          const entryRemarks = `Payment against Invoice ${invoiceNo} (Sale ${saleId})${(remarks ?? existing.remarks) ? ` — ${remarks ?? existing.remarks}` : ""
            }`;

          await tx.ledgerEntry.create({
            data: {
              accountId: partyAccount.id,
              entryType: "PAYMENT",
              debit: 0,
              credit: oldAmt,
              saleId,
              vendorCustomerPaymentId: id,
              transactionDate: parsedDate,
              remarks: entryRemarks,
            },
          });

          // ---- Cash leg per allocation (unchanged split, CASH only) ----
          if (newMethod === "CASH") {
            await tx.ledgerEntry.create({
              data: {
                accountId: cash.id,
                entryType: "PAYMENT",
                debit: 0,
                credit: oldAmt,
                saleId,
                vendorCustomerPaymentId: id,
                transactionDate: parsedDate,
                remarks: `Cash received against Invoice ${invoiceNo} (Sale ${saleId})${(remarks ?? existing.remarks) ? ` — ${remarks ?? existing.remarks}` : ""
                  }`,
              },
            });
          }
        }
      } else if (isSingleSalePayment) {
        const invoiceNo = sale.invoice?.invoiceNo ?? "N/A";
        const entryRemarks = `Payment against Invoice ${invoiceNo} (Sale ${sale.id})${(remarks ?? existing.remarks) ? ` — ${remarks ?? existing.remarks}` : ""
          }`;

        if (partyAccount) {
          await tx.ledgerEntry.create({
            data: {
              accountId: partyAccount.id,
              entryType: "PAYMENT",
              debit: 0,
              credit: newAmount,
              saleId: sale.id,
              vendorCustomerPaymentId: id,
              transactionDate: parsedDate,
              remarks: entryRemarks,
            },
          });
        }

        if (newMethod === "CASH") {
          await tx.ledgerEntry.create({
            data: {
              accountId: cash.id,
              entryType: "PAYMENT",
              debit: 0,
              credit: newAmount,
              saleId: sale.id,
              vendorCustomerPaymentId: id,
              transactionDate: parsedDate,
              remarks: `Cash received against Invoice ${invoiceNo} (Sale ${sale.id})${(remarks ?? existing.remarks) ? ` — ${remarks ?? existing.remarks}` : ""
                }`,
            },
          });
        } else {
          await tx.ledgerEntry.create({
            data: {
              accountId: newBank.account.id,
              entryType: "PAYMENT",
              debit: 0,
              credit: newAmount,
              saleId: sale.id,
              vendorCustomerPaymentId: id,
              transactionDate: parsedDate,
              remarks: `Bank transfer received against Invoice ${invoiceNo} (Sale ${sale.id})${(remarks ?? existing.remarks) ? ` — ${remarks ?? existing.remarks}` : ""
                }`,
            },
          });
        }

        // ---- Update the sale's paid amount + status ----
        const { netRefundToCustomer, paidAmountAfterReversal } = singleSaleCtx;
        const clamped = Math.max(0, paidAmountAfterReversal + newAmount);
        const fullyPaidThreshold = sale.sellPrice - netRefundToCustomer;
        const newSaleStatus =
          clamped <= 0 ? "DUE" : clamped >= fullyPaidThreshold ? "PAID" : "PARTIAL";

        await tx.sale.update({
          where: { id: sale.id },
          data: { paidAmount: clamped, paymentStatus: newSaleStatus },
        });
      } else {
        // VENDOR — single combined leg, unchanged behavior
        await tx.ledgerEntry.create({
          data: {
            accountId: partyAccount.id,
            entryType: "PAYMENT",
            debit: partyLegDebit,
            credit: partyLegCredit,
            vendorCustomerPaymentId: id,
            transactionDate: parsedDate,
            remarks: remarks ?? existing.remarks ?? null,
          },
        });

        // ---- Cash leg (VENDOR + CASH) — single combined entry ----
        if (newMethod === "CASH") {
          await tx.ledgerEntry.create({
            data: {
              accountId: cash.id,
              entryType: "PAYMENT",
              debit: cashLegDebit,
              credit: cashLegCredit,
              vendorCustomerPaymentId: id,
              transactionDate: parsedDate,
              remarks: remarks ?? existing.remarks ?? null,
            },
          });
        }
      }

      // 5. Apply party balance delta (net shift from old amount -> new amount)
      //    Guarded — a walk-in single-sale payment has no partyAccount at all.
      if (partyAccount) {
        await tx.account.update({
          where: { id: partyAccount.id },
          data: { balance: { increment: partyBalanceDelta } },
        });
      }

      // 6. Apply new bank balance (+ generic ledger entry for VENDOR/multi-
      //    sale CUSTOMER only — single-sale payments already created their
      //    own saleId-tagged bank entry above in step 4, so creating another
      //    one here would double-book the same money).
      if (newMethod === "BANK_TRANSFER") {
        const bankBalanceDelta = partyType === "VENDOR" ? -newAmount : newAmount;
        await tx.account.update({
          where: { id: newBank.account.id },
          data: { balance: { increment: bankBalanceDelta } },
        });

        if (!isSingleSalePayment) {
          await tx.ledgerEntry.create({
            data: {
              accountId: newBank.account.id,
              entryType: "PAYMENT",
              debit: bankLegDebit,
              credit: bankLegCredit,
              vendorCustomerPaymentId: id,
              transactionDate: parsedDate,
              remarks: remarks ?? existing.remarks ?? null,
            },
          });
        }
      }

      // 7. Apply new cash balance (only for CASH) — balance only, no entry
      //    here; the entry was already created per-branch above in step 4.
      if (newMethod === "CASH") {
        const cashBalanceDelta = partyType === "VENDOR" ? -newAmount : newAmount;
        await tx.account.update({
          where: { id: cash.id },
          data: { balance: { increment: cashBalanceDelta } },
        });
      }

      return updated;
    }, { timeout: 30000, maxWait: 10000 });

    const fullPayment = await prisma.vendorCustomerPayment.findUnique({
      where: { id: result.id },
      include: {
        vendor: { select: { id: true, vendorName: true, category: true } },
        customer: { select: { id: true, customerName: true } },
        sale: {
          select: {
            id: true,
            documentNo: true,
            invoice: { select: { id: true, invoiceNo: true } },
          },
        },
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        account: { select: { id: true, name: true, type: true, balance: true } },
        createdBy: { select: { id: true, fullName: true } }, // NEW
        branch: { select: { id: true, name: true, code: true } }, // NEW
        ledgerEntries: true,
      },
    });

    res.status(200).json({
      success: true,
      data: {
        ...fullPayment,
        isWalkIn: !fullPayment.customerId && !fullPayment.vendorId && !!fullPayment.saleId,
      },
    });
  } catch (err) {
    console.error("Error updating payment:", err);
    res.status(500).json({ success: false, error: "Failed to update payment" });
  }
});
// ---- DELETE ----
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.vendorCustomerPayment.findUnique({
      where: { id },
      include: { ledgerEntries: true },
    });

    if (!existing)
      return res.status(404).json({ success: false, error: "Payment not found" });

    let partyAccount = null;
    let vendorCategory = null;

    if (existing.partyType === "VENDOR") {
      const vendor = await prisma.vendor.findUnique({
        where: { id: existing.vendorId },
        include: { account: true },
      });
      partyAccount = vendor.account;
      vendorCategory = vendor.category; // "DEBIT" | "CREDIT"
    } else if (existing.customerId) {
      const customer = await prisma.customer.findUnique({
        where: { id: existing.customerId },
        include: { account: true },
      });
      partyAccount = customer?.account ?? null;
    }
    // else: partyType === "CUSTOMER" && !customerId (walk-in) — partyAccount stays null

    let bankAccount = null;
    if (existing.method === "BANK_TRANSFER" && existing.bankId) {
      const bank = await prisma.bank.findUnique({
        where: { id: existing.bankId },
        include: { account: true },
      });
      bankAccount = bank?.account ?? null;
    }

    // ---- Load cash account (if this payment used CASH) ----
    let cashAccount = null;
    if (existing.method === "CASH" && existing.accountId) {
      cashAccount = await prisma.account.findUnique({ where: { id: existing.accountId } });
    }
    let partyReverseDelta = 0;
    if (existing.partyType === "VENDOR" && vendorCategory === "DEBIT") {
      // Original effect was -amount (payment reduced balance owed). Reverse = +amount.
      partyReverseDelta = existing.amount;
    } else if (existing.partyType === "VENDOR" && vendorCategory === "CREDIT") {
      // Original effect was +amount. Reverse = -amount.
      partyReverseDelta = -existing.amount;
    } else if (existing.partyType === "CUSTOMER" && partyAccount) {

      partyReverseDelta = existing.amount;
    }
    let saleReversals = []; // [{ saleId, amountToReverse }]
    let salesById = new Map();

    if (existing.partyType === "CUSTOMER") {
      if (existing.saleId) {
        saleReversals = [{ saleId: existing.saleId, amountToReverse: existing.amount }];
      } else if (partyAccount) {
        const perSaleMap = new Map();
        existing.ledgerEntries.forEach((e) => {
          if (e.saleId && e.accountId === partyAccount.id) {
            perSaleMap.set(e.saleId, (perSaleMap.get(e.saleId) || 0) + e.credit);
          }
        });

        saleReversals = [...perSaleMap.entries()].map(([saleId, amountToReverse]) => ({
          saleId,
          amountToReverse,
        }));
      }

      if (saleReversals.length > 0) {
        const saleIds = saleReversals.map((s) => s.saleId);
        const sales = await prisma.sale.findMany({ where: { id: { in: saleIds } } });
        salesById = new Map(sales.map((s) => [s.id, s]));
      }
    }

    await prisma.$transaction(async (tx) => {
      if (partyAccount) {
        await tx.account.update({
          where: { id: partyAccount.id },
          data: { balance: { increment: partyReverseDelta } },
        });
      }

      // Reverse bank account balance (debit - credit is the correct reversal here)
      if (bankAccount) {
        const bankEntry = existing.ledgerEntries.find((e) => e.accountId === bankAccount.id);
        const bankReverseDelta = (bankEntry?.debit ?? 0) - (bankEntry?.credit ?? 0);
        await tx.account.update({
          where: { id: bankAccount.id },
          data: { balance: { increment: bankReverseDelta } },
        });
      }

      // Reverse cash account balance — sum debit-credit across ALL cash entries
      // tied to this payment (CUSTOMER payments may have one entry per sale).
      if (cashAccount) {
        const cashEntries = existing.ledgerEntries.filter((e) => e.accountId === cashAccount.id);
        const cashReverseDelta = cashEntries.reduce((sum, e) => sum + (e.debit - e.credit), 0);
        await tx.account.update({
          where: { id: cashAccount.id },
          data: { balance: { increment: cashReverseDelta } },
        });
      }
      for (const { saleId, amountToReverse } of saleReversals) {
        const sale = salesById.get(saleId);
        if (!sale) continue;

        const newPaidAmount = Math.max(0, Number(sale.paidAmount || 0) - amountToReverse);
        const newStatus =
          newPaidAmount <= 0
            ? "DUE"
            : newPaidAmount >= Number(sale.sellPrice || 0)
              ? "PAID"
              : "PARTIAL";

        await tx.sale.update({
          where: { id: saleId },
          data: { paidAmount: newPaidAmount, paymentStatus: newStatus },
        });
      }

      // Delete ledger entries then the payment
      await tx.ledgerEntry.deleteMany({ where: { vendorCustomerPaymentId: id } });
      await tx.vendorCustomerPayment.delete({ where: { id } });
    });

    res.status(200).json({ success: true, message: "Payment deleted successfully" });
  } catch (err) {
    console.error("Error deleting payment:", err);
    res.status(500).json({ success: false, error: "Failed to delete payment" });
  }
});
export default router;