import express from "express";
import { PrismaClient } from "@prisma/client";


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


router.post("/", async (req, res) => {
    try {
        const {
            partyType,
            vendorId,
            customerId,
            method,
            bankId,
            amount,
            attachmentUrl,
            remarks,
            transactionDate,
        } = req.body;

        // ---- Basic required-field checks ----
        if (!partyType || !method || amount === undefined || !transactionDate)
            return res.status(400).json({
                success: false,
                error: "partyType, method, amount and transactionDate are required",
            });

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

        if (typeof amount !== "number" || amount <= 0)
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

            // ✅ Add this block
            if (partyType === "VENDOR" && amount > bank.account.balance)
                return res.status(400).json({
                    success: false,
                    error: `Insufficient bank balance. Trying to pay ${amount} but bank only has ${bank.account.balance} available.`,
                });
        }

        // ---- Determine ledger direction + enforce balance cap rules ----
        // VENDOR + category=DEBIT  -> paying down what you owe; capped at current balance; DEBIT the vendor account
        // VENDOR + category=CREDIT -> topping up prepaid credit; no cap; CREDIT the vendor account
        // CUSTOMER                 -> paying down what they owe you; capped at current balance; CREDIT the customer account
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
            partyLegDebit = amount;    // Fixed
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

        // Bank leg: vendor payment (DEBIT or CREDIT) -> money leaves bank -> CREDIT bank account
        //           customer payment                  -> money enters bank -> DEBIT bank account
        let bankLegDebit = 0;
        let bankLegCredit = 0;
        let bankBalanceDelta = 0;

        if (method === "BANK_TRANSFER") {
            if (partyType === "VENDOR") {
                bankLegDebit = amount;    // Money leaves bank → Debit
                bankBalanceDelta = -amount;
            } else {
                bankLegCredit = amount;   // Money enters bank → Credit
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
                    attachmentUrl: attachmentUrl ?? null,
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

export default router;