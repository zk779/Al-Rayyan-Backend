import express from "express";
import { PrismaClient } from "@prisma/client";
import {upload} from "../middleware/cloudinary.js";


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


// Inject upload.single("attachment") into the POST route
router.post("/", upload.single("attachment"), async (req, res) => {
    try {
        let {
            partyType,
            vendorId,
            customerId,
            method,
            bankId,
            amount,
            remarks,
            transactionDate,
        } = req.body;

        // 1. Capture the Cloudinary URL if a file was uploaded
        // If an attachment is uploaded, req.file.path contains the secure Cloudinary URL
        const attachmentUrl = req.file ? req.file.path : null;

        // ---- Basic required-field checks ----
        if (!partyType || !method || amount === undefined || !transactionDate)
            return res.status(400).json({
                success: false,
                error: "partyType, method, amount and transactionDate are required",
            });

        // 2. Convert amount to a number (multipart/form-data passes numbers as strings)
        amount = Number(amount);

        if (!["VENDOR", "CUSTOMER"].includes(partyType))
            return res.status(400).json({
                success: false,
                error: "partyType must be either VENDOR or CUSTOMER",
            });

        if (!["CASH", "BANK_TRANSFER"].includes(method))
            return res.status(400).json({
                success: false,
                error: "method must be either CASH or BANK_TRANSFER",
            });

        if (isNaN(amount) || amount <= 0)
            return res.status(400).json({
                success: false,
                error: "amount must be a number greater than 0",
            });

        // ---- partyType / id consistency checks ----
        if (partyType === "VENDOR" && !vendorId)
            return res.status(400).json({
                success: false,
                error: "vendorId is required when partyType is VENDOR",
            });

        if (partyType === "VENDOR" && customerId)
            return res.status(400).json({
                success: false,
                error: "customerId must not be set when partyType is VENDOR",
            });

        if (partyType === "CUSTOMER" && !customerId)
            return res.status(400).json({
                success: false,
                error: "customerId is required when partyType is CUSTOMER",
            });

        if (partyType === "CUSTOMER" && vendorId)
            return res.status(400).json({
                success: false,
                error: "vendorId must not be set when partyType is CUSTOMER",
            });

        // ---- method / bankId consistency checks ----
        if (method === "BANK_TRANSFER" && !bankId)
            return res.status(400).json({
                success: false,
                error: "bankId is required when method is BANK_TRANSFER",
            });

        if (method === "CASH" && bankId)
            return res.status(400).json({
                success: false,
                error: "bankId must not be set when method is CASH",
            });

        // ---- Validate transactionDate ----
        const parsedDate = new Date(transactionDate);
        if (isNaN(parsedDate.getTime()))
            return res.status(400).json({
                success: false,
                error: "transactionDate must be a valid date",
            });

        // ---- Load the party + its account ----
        let vendor = null;
        let customer = null;

        if (partyType === "VENDOR") {
            vendor = await prisma.vendor.findUnique({
                where: { id: vendorId },
                include: { account: true },
            });

            if (!vendor)
                return res.status(404).json({ success: false, error: "Vendor not found" });

            if (!vendor.status)
                return res.status(400).json({ success: false, error: "Vendor is inactive" });
        } else {
            customer = await prisma.customer.findUnique({
                where: { id: customerId },
                include: { account: true },
            });

            if (!customer)
                return res.status(404).json({ success: false, error: "Customer not found" });

            if (!customer.isActive)
                return res.status(400).json({ success: false, error: "Customer is inactive" });
        }

        // ---- Load the bank if relevant ----
        let bank = null;
        if (method === "BANK_TRANSFER") {
            bank = await prisma.bank.findUnique({
                where: { id: bankId },
                include: { account: true },
            });

            if (!bank)
                return res.status(404).json({ success: false, error: "Bank not found" });

            if (!bank.isActive)
                return res.status(400).json({ success: false, error: "Bank account is inactive" });

            if (partyType === "VENDOR" && amount > bank.account.balance)
                return res.status(400).json({
                    success: false,
                    error: `Insufficient bank balance. Trying to pay ${amount} but bank only has ${bank.account.balance} available.`,
                });
        }

        // ---- Determine ledger direction + enforce balance cap rules ----
        const partyAccount = partyType === "VENDOR" ? vendor.account : customer.account;
        const currentBalance = partyAccount.balance;

        let partyLegDebit = 0;
        let partyLegCredit = 0;
        let partyBalanceDelta = 0;

        if (partyType === "VENDOR" && vendor.category === "DEBIT") {
            if (amount > currentBalance)
                return res.status(400).json({
                    success: false,
                    error: `Payment amount (${amount}) exceeds vendor's outstanding balance (${currentBalance}).`,
                });

            partyLegDebit = amount;
            partyBalanceDelta = -amount;
        } else if (partyType === "VENDOR" && vendor.category === "CREDIT") {
            partyLegDebit = amount;
            partyBalanceDelta = amount;
        } else if (partyType === "CUSTOMER") {
            if (amount > currentBalance)
                return res.status(400).json({
                    success: false,
                    error: `Payment amount (${amount}) exceeds customer's outstanding balance (${currentBalance}).`,
                });

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

        // ---- Persist everything atomically ----
        const result = await prisma.$transaction(async (tx) => {
            const payment = await tx.vendorCustomerPayment.create({
                data: {
                    partyType,
                    vendorId: partyType === "VENDOR" ? vendorId : null,
                    customerId: partyType === "CUSTOMER" ? customerId : null,
                    method,
                    amount,
                    bankId: method === "BANK_TRANSFER" ? bankId : null,
                    attachmentUrl: attachmentUrl, // 3. The verified URL string drops straight into DB
                    remarks: remarks ?? null,
                    transactionDate: parsedDate,
                },
            });

            // Party leg
            await tx.account.update({
                where: { id: partyAccount.id },
                data: { balance: { increment: partyBalanceDelta } },
            });

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

            // Bank leg (only for BANK_TRANSFER)
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

            return payment;
        });

        const fullPayment = await prisma.vendorCustomerPayment.findUnique({
            where: { id: result.id },
            include: {
                vendor: { select: { id: true, vendorName: true, category: true } },
                customer: { select: { id: true, customerName: true } },
                bank: { select: { id: true, bankName: true, accountNumber: true } },
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
    const payments = await prisma.vendorCustomerPayment.findMany({
      include: {
        vendor: { select: { id: true, vendorName: true, category: true } },
        customer: { select: { id: true, customerName: true } },
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        ledgerEntries: true,
      },
      orderBy: { transactionDate: "desc" },
    });

    res.status(200).json({ success: true, data: payments });
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
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        ledgerEntries: true,
      },
    });

    if (!payment)
      return res.status(404).json({ success: false, error: "Payment not found" });

    res.status(200).json({ success: true, data: payment });
  } catch (err) {
    console.error("Error fetching payment:", err);
    res.status(500).json({ success: false, error: "Failed to fetch payment" });
  }
});


// ---- PUT (UPDATE) ----
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, attachmentUrl, remarks, transactionDate, method, bankId } = req.body;

    // ---- Load existing payment ----
    const existing = await prisma.vendorCustomerPayment.findUnique({
      where: { id },
      include: { ledgerEntries: true },
    });

    if (!existing)
      return res.status(404).json({ success: false, error: "Payment not found" });

    // ---- Validate editable fields ----
    if (amount !== undefined && (typeof amount !== "number" || amount <= 0))
      return res.status(400).json({ success: false, error: "amount must be a number greater than 0" });

    if (transactionDate !== undefined) {
      const parsed = new Date(transactionDate);
      if (isNaN(parsed.getTime()))
        return res.status(400).json({ success: false, error: "transactionDate must be a valid date" });
    }

    // ---- method / bankId consistency ----
    const newMethod = method ?? existing.method;
    const newBankId = bankId !== undefined ? bankId : existing.bankId;

    if (newMethod === "BANK_TRANSFER" && !newBankId)
      return res.status(400).json({ success: false, error: "bankId is required when method is BANK_TRANSFER" });

    if (newMethod === "CASH" && newBankId)
      return res.status(400).json({ success: false, error: "bankId must not be set when method is CASH" });

    const newAmount = amount ?? existing.amount;
    const parsedDate = transactionDate ? new Date(transactionDate) : existing.transactionDate;
    const partyType = existing.partyType;

    // ---- Load party account ----
    let partyAccount = null;
    let vendor = null;
    let customer = null;

    if (partyType === "VENDOR") {
      vendor = await prisma.vendor.findUnique({
        where: { id: existing.vendorId },
        include: { account: true },
      });
      partyAccount = vendor.account;
    } else {
      customer = await prisma.customer.findUnique({
        where: { id: existing.customerId },
        include: { account: true },
      });
      partyAccount = customer.account;
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

    // ---- Find old bank account/entry (needed only to reverse the BANK leg) ----
    // NOTE: We do NOT reverse the party leg this way — partyBalanceDelta below is
    // already the net shift from old amount -> new amount, computed directly from
    // the party's category rules (same convention as the POST route). Reversing
    // via old ledger debit/credit AND applying the delta would double-count.
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

    // ---- Recompute new ledger directions (delta between old amount and new amount) ----
    let partyLegDebit = 0;
    let partyLegCredit = 0;
    let partyBalanceDelta = 0;

    if (partyType === "VENDOR" && vendor.category === "DEBIT") {
      // Debit vendor: balance = amount still owed to vendor. Paying reduces it.
      const restoredBalance = partyAccount.balance + existing.amount; // balance before old payment
      if (newAmount > restoredBalance)
        return res.status(400).json({
          success: false,
          error: `Payment amount (${newAmount}) exceeds vendor's outstanding balance (${restoredBalance}).`,
        });

      partyLegDebit = newAmount;
      partyBalanceDelta = -(newAmount - existing.amount); // shift balance down by the change in payment
    } else if (partyType === "VENDOR" && vendor.category === "CREDIT") {
      // Credit vendor: paying increases balance (amount we've advanced/credited them)
      partyLegDebit = newAmount;
      partyBalanceDelta = newAmount - existing.amount;
    } else if (partyType === "CUSTOMER") {
      const restoredBalance = partyAccount.balance + existing.amount; // balance before old payment
      if (newAmount > restoredBalance)
        return res.status(400).json({
          success: false,
          error: `Payment amount (${newAmount}) exceeds customer's outstanding balance (${restoredBalance}).`,
        });

      partyLegCredit = newAmount;
      partyBalanceDelta = -(newAmount - existing.amount);
    }

    // ---- Bank leg ----
    let bankLegDebit = 0;
    let bankLegCredit = 0;

    if (newMethod === "BANK_TRANSFER") {
      if (partyType === "VENDOR") {
        // Check bank has enough after reversing old bank debit
        const restoredBankBalance =
          oldBankAccount?.id === newBank.account.id
            ? newBank.account.balance + existing.amount // same bank: restore old debit first
            : newBank.account.balance;

        if (newAmount > restoredBankBalance)
          return res.status(400).json({
            success: false,
            error: `Insufficient bank balance. Trying to pay ${newAmount} but bank only has ${restoredBankBalance} available.`,
          });

        bankLegDebit = newAmount;
      } else {
        bankLegCredit = newAmount;
      }
    }

    // ---- Persist atomically ----
    const result = await prisma.$transaction(async (tx) => {
      // 1. Reverse old bank balance if old method was BANK_TRANSFER
      //    (Bank leg uses full reverse + full reapply, unlike the party leg,
      //    because it may move to a *different* bank account entirely.)
      if (existing.method === "BANK_TRANSFER" && oldBankAccount) {
        const oldBankDelta = (oldBankEntry?.debit ?? 0) - (oldBankEntry?.credit ?? 0);
        await tx.account.update({
          where: { id: oldBankAccount.id },
          data: { balance: { increment: oldBankDelta } },
        });
      }

      // 2. Delete old ledger entries
      await tx.ledgerEntry.deleteMany({ where: { vendorCustomerPaymentId: id } });

      // 3. Update the payment record
      const updated = await tx.vendorCustomerPayment.update({
        where: { id },
        data: {
          amount: newAmount,
          method: newMethod,
          bankId: newMethod === "BANK_TRANSFER" ? newBankId : null,
          attachmentUrl: attachmentUrl ?? existing.attachmentUrl,
          remarks: remarks ?? existing.remarks,
          transactionDate: parsedDate,
        },
      });

      // 4. Apply party balance delta (net shift from old amount -> new amount) + ledger entry
      await tx.account.update({
        where: { id: partyAccount.id },
        data: { balance: { increment: partyBalanceDelta } },
      });

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

      // 5. Apply new bank balance + ledger entry
      if (newMethod === "BANK_TRANSFER") {
        const bankBalanceDelta = partyType === "VENDOR" ? -newAmount : newAmount;
        await tx.account.update({
          where: { id: newBank.account.id },
          data: { balance: { increment: bankBalanceDelta } },
        });

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

      return updated;
    });

    const fullPayment = await prisma.vendorCustomerPayment.findUnique({
      where: { id: result.id },
      include: {
        vendor: { select: { id: true, vendorName: true, category: true } },
        customer: { select: { id: true, customerName: true } },
        bank: { select: { id: true, bankName: true, accountNumber: true } },
        ledgerEntries: true,
      },
    });

    res.status(200).json({ success: true, data: fullPayment });
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

    // ---- Load party account (+ vendor category, needed to know reversal direction) ----
    let partyAccount = null;
    let vendorCategory = null;

    if (existing.partyType === "VENDOR") {
      const vendor = await prisma.vendor.findUnique({
        where: { id: existing.vendorId },
        include: { account: true },
      });
      partyAccount = vendor.account;
      vendorCategory = vendor.category; // "DEBIT" | "CREDIT"
    } else {
      const customer = await prisma.customer.findUnique({
        where: { id: existing.customerId },
        include: { account: true },
      });
      partyAccount = customer.account;
    }

    let bankAccount = null;
    if (existing.method === "BANK_TRANSFER" && existing.bankId) {
      const bank = await prisma.bank.findUnique({
        where: { id: existing.bankId },
        include: { account: true },
      });
      bankAccount = bank?.account ?? null;
    }

    // ---- Compute the correct reversal for the party leg ----
    // This must mirror the ORIGINAL balance effect (from the POST route), negated.
    // We can't safely derive this from (debit - credit) on the ledger entry, because
    // that convention only lines up as the true negative of the balance effect for
    // the bank leg — not for the party leg (CUSTOMER / VENDOR-CREDIT have the same
    // sign as debit-credit, so using it directly would double the change instead of
    // undoing it).
    let partyReverseDelta = 0;
    if (existing.partyType === "VENDOR" && vendorCategory === "DEBIT") {
      // Original effect was -amount (payment reduced balance owed). Reverse = +amount.
      partyReverseDelta = existing.amount;
    } else if (existing.partyType === "VENDOR" && vendorCategory === "CREDIT") {
      // Original effect was +amount. Reverse = -amount.
      partyReverseDelta = -existing.amount;
    } else if (existing.partyType === "CUSTOMER") {
      // Original effect was -amount. Reverse = +amount.
      partyReverseDelta = existing.amount;
    }

    await prisma.$transaction(async (tx) => {
      // Reverse party account balance
      await tx.account.update({
        where: { id: partyAccount.id },
        data: { balance: { increment: partyReverseDelta } },
      });

      // Reverse bank account balance (debit - credit is the correct reversal here)
      if (bankAccount) {
        const bankEntry = existing.ledgerEntries.find((e) => e.accountId === bankAccount.id);
        const bankReverseDelta = (bankEntry?.debit ?? 0) - (bankEntry?.credit ?? 0);
        await tx.account.update({
          where: { id: bankAccount.id },
          data: { balance: { increment: bankReverseDelta } },
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