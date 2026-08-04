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

router.post("/:saleId", authenticate, upload.single("attachment"), async (req, res) => {
    try {
        const { saleId } = req.params;
        let { method, bankId, bankSlipNo, amount, remarks, transactionDate } = req.body; // NEW: bankSlipNo

        const attachmentUrl = req.file ? req.file.path : null;

        // ---- Basic required-field checks ----
        if (!method || !transactionDate)
            return res.status(400).json({
                success: false,
                error: "method and transactionDate are required",
            });

        if (!["CASH", "BANK_TRANSFER"].includes(method))
            return res.status(400).json({
                success: false,
                error: "method must be either CASH or BANK_TRANSFER",
            });

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

        const parsedDate = new Date(transactionDate);
        if (isNaN(parsedDate.getTime()))
            return res.status(400).json({
                success: false,
                error: "transactionDate must be a valid date",
            });

        amount = Number(amount);
        if (isNaN(amount) || amount <= 0)
            return res.status(400).json({
                success: false,
                error: "amount must be a number greater than 0",
            });

        const sale = await prisma.sale.findUnique({
            where: { id: saleId },
            include: {
                invoice: { select: { invoiceNo: true } },
                customer: { include: { account: true } },
                refunds: { select: { netRefundToCustomer: true } },
            },
        });

        if (!sale)
            return res.status(404).json({ success: false, error: "Sale not found" });

        if (!["DUE", "PARTIAL"].includes(sale.paymentStatus))
            return res.status(400).json({
                success: false,
                error: `Sale is already ${sale.paymentStatus} and cannot accept further payment`,
            });

        const refund = sale.refunds && sale.refunds.length > 0 ? sale.refunds[0] : null;
        const netRefundToCustomer = refund ? Number(refund.netRefundToCustomer || 0) : 0;

        const remainingDue = sale.sellPrice - (sale.paidAmount || 0) - netRefundToCustomer;

        if (amount > remainingDue)
            return res.status(400).json({
                success: false,
                error: `Payment amount (${amount}) exceeds the sale's remaining due (${remainingDue})`,
            });

        const hasCustomer = !!sale.customerId && !!sale.customer;

        if (hasCustomer && amount > sale.customer.account.balance)
            return res.status(400).json({
                success: false,
                error: `Payment amount (${amount}) exceeds customer's outstanding balance (${sale.customer.account.balance})`,
            });

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
        }

        const invoiceNo = sale.invoice?.invoiceNo ?? "N/A";
        const baseRemarks = `Payment against Invoice ${invoiceNo} (Sale ${sale.id})${
            remarks ? ` — ${remarks}` : ""
        }`;

        const result = await prisma.$transaction(async (tx) => {
            const getCashAccount = async () => {
                let cash = await tx.account.findFirst({ where: { type: "CASH" } });
                if (!cash) {
                    cash = await tx.account.create({
                        data: { name: "Cash Account", type: "CASH", balance: 0 },
                    });
                }
                return cash;
            };

            const cash = method === "CASH" ? await getCashAccount() : null;

            // NEW — sequential PV number, scoped to the user's branch + year
            const pvNo = await generateNextPvNo(tx, req.user.branchCode, parsedDate);

            const payment = await tx.vendorCustomerPayment.create({
                data: {
                    partyType: "CUSTOMER",
                    customerId: hasCustomer ? sale.customerId : null,
                    saleId: sale.id,
                    method,
                    amount,
                    bankId: method === "BANK_TRANSFER" ? bankId : null,
                    accountId: method === "CASH" ? cash.id : null,
                    attachmentUrl,
                    remarks: remarks ?? null,
                    transactionDate: parsedDate,
                    pvNo,                          // NEW
                    bankSlipNo: bankSlipNo ?? null, // NEW
                    createdById: req.user.id,       // NEW
                    branchId: req.user.branchId,    // NEW
                },
            });

            if (hasCustomer) {
                await tx.ledgerEntry.create({
                    data: {
                        accountId: sale.customer.account.id,
                        entryType: "PAYMENT",
                        debit: 0,
                        credit: amount,
                        saleId: sale.id,
                        vendorCustomerPaymentId: payment.id,
                        transactionDate: parsedDate,
                        remarks: baseRemarks,
                    },
                });

                await tx.account.update({
                    where: { id: sale.customer.account.id },
                    data: { balance: { decrement: amount } },
                });
            }

            if (method === "CASH") {
                await tx.ledgerEntry.create({
                    data: {
                        accountId: cash.id,
                        entryType: "PAYMENT",
                        debit: 0,
                        credit: amount,
                        saleId: sale.id,
                        vendorCustomerPaymentId: payment.id,
                        transactionDate: parsedDate,
                        remarks: baseRemarks,
                    },
                });

                await tx.account.update({
                    where: { id: cash.id },
                    data: { balance: { increment: amount } },
                });
            } else {
                await tx.ledgerEntry.create({
                    data: {
                        accountId: bank.account.id,
                        entryType: "PAYMENT",
                        debit: 0,
                        credit: amount,
                        saleId: sale.id,
                        vendorCustomerPaymentId: payment.id,
                        transactionDate: parsedDate,
                        remarks: baseRemarks,
                    },
                });

                await tx.account.update({
                    where: { id: bank.account.id },
                    data: { balance: { increment: amount } },
                });
            }

            const newPaidAmount = (sale.paidAmount || 0) + amount;
            const fullyPaidThreshold = sale.sellPrice - netRefundToCustomer;
            const newStatus = newPaidAmount >= fullyPaidThreshold ? "PAID" : "PARTIAL";

            const updatedSale = await tx.sale.update({
                where: { id: sale.id },
                data: {
                    paidAmount: newPaidAmount,
                    paymentStatus: newStatus,
                },
            });

            return { payment, sale: updatedSale };
        }, { timeout: 30000, maxWait: 10000 }); // added, matches the other routes' timeout fix

        const fullPayment = await prisma.vendorCustomerPayment.findUnique({
            where: { id: result.payment.id },
            include: {
                customer: { select: { id: true, customerName: true } },
                bank: { select: { id: true, bankName: true, accountNumber: true } },
                account: { select: { id: true, name: true, type: true, balance: true } },
                sale: {
                    select: {
                        id: true,
                        documentNo: true,
                        invoice: { select: { id: true, invoiceNo: true } },
                    },
                },
                createdBy: { select: { id: true, fullName: true } }, // NEW
                branch: { select: { id: true, name: true, code: true } }, // NEW
                ledgerEntries: true,
            },
        });

        res.status(201).json({
            success: true,
            data: {
                payment: fullPayment,
                sale: result.sale,
            },
        });
    } catch (err) {
        console.error("Error creating sale payment:", err);
        res.status(500).json({ success: false, error: "Failed to create sale payment" });
    }
});

export default router;