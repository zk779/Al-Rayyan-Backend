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

/* ======================= GET ALL REFUNDS (LIST) ======================= */
/* ======================= GET ALL REFUNDS (LIST) ======================= */
router.get("/", authenticate, async (req, res) => {
    const {
        page = 1,
        limit = 20,
        status,
        saleId,
        startDate,
        endDate,
        sortBy = "createdAt",
        sortOrder = "desc"
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where = {};

    if (status) {
        where.status = status.toUpperCase();
    }

    if (saleId) {
        where.saleId = saleId;
    }

    if (startDate || endDate) {
        where.refundDate = {};
        if (startDate) where.refundDate.gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            where.refundDate.lte = end;
        }
    }

    try {
        const [refunds, total] = await prisma.$transaction([
            prisma.refund.findMany({
                where,
                skip,
                take,
                orderBy: { [sortBy]: sortOrder },
                include: {
                    sale: {
                        select: {
                            id: true,
                            netPrice: true,
                            sellPrice: true,
                            // ✅ FIXED: Using vendorName instead of name
                            vendor: { select: { id: true, vendorName: true } },
                            // ✅ FIXED: Using customerName instead of name
                            customer: { select: { id: true, customerName: true } },
                            invoice: {
                                select: {
                                    id: true,
                                    invoiceNo: true,
                                    saleDate: true
                                }
                            }
                        }
                    },
                    processedBy: {
                        // ✅ FIXED: Using fullName instead of name
                        select: { id: true, fullName: true, email: true }
                    }
                }
            }),
            prisma.refund.count({ where })
        ]);

        return res.json({
            success: true,
            data: refunds,
            pagination: {
                total,
                page: Number(page),
                pages: Math.ceil(total / take),
                limit: take
            }
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({
            success: false,
            error: "Failed to fetch refunds"
        });
    }
});

/* ======================= GET REFUND BY ID ======================= */
/* ======================= GET REFUND BY ID ======================= */
router.get("/:refundId", authenticate, async (req, res) => {
    const { refundId } = req.params;

    try {
        const refund = await prisma.refund.findUnique({
            where: { id: refundId },
            include: {
                sale: {
                    include: {
                        vendor: { include: { account: true } },
                        customer: { include: { account: true } },
                        invoice: true
                    }
                },
                processedBy: {
                    // ✅ FIXED: Using fullName instead of name
                    select: { id: true, fullName: true, email: true }
                }
            }
        });

        if (!refund) {
            return res.status(404).json({
                success: false,
                error: "Refund not found"
            });
        }

        return res.json({ success: true, data: refund });

    } catch (err) {
        console.error(err);
        return res.status(500).json({
            success: false,
            error: "Failed to fetch refund details"
        });
    }
});

/* ======================= CREATE REFUND ======================= */
router.post("/", authenticate, async (req, res) => {
    const {
        saleId,
        refundDate,
        refundFee,
        serviceCharges,
        refundReason,
        remarks
    } = req.body;

    if (!saleId) {
        return res.status(400).json({ success: false, error: "saleId is required" });
    }

    const fee = Number(refundFee || 0);
    const charges = Number(serviceCharges || 0);

    try {
        const businessDate = refundDate ? new Date(refundDate) : new Date();

        const result = await prisma.$transaction(async (tx) => {
            const originalSale = await tx.sale.findUnique({
                where: { id: saleId },
                include: {
                    vendor: { include: { account: true } },
                    customer: { include: { account: true } },
                    invoice: true,
                }
            });

            if (!originalSale) throw new Error("Original sale not found");

            const existingRefund = await tx.refund.findFirst({ where: { saleId } });
            if (existingRefund) throw new Error("This sale has already been refunded");

            /* ====================================================
               REFUND LOGIC (BASE: NET PRICE)
            ==================================================== */
            const originalNet = Number(originalSale.netPrice); // Cost price
            const originalSell = Number(originalSale.sellPrice); // Sale price

            // 1. Vendor Refund: What the vendor gives back to us
            const vendorRefundAmount = originalNet - fee;

            // 2. Customer Refund Amount: Based on NET price as requested
            // We are ignoring the sellPrice margin here.
            const customerRefundAmount = originalNet - fee;

            // 3. Net to Customer: What they get after your service charges
            const netRefundToCustomer = customerRefundAmount - charges;

            /* VENDOR LEDGER */
            const vendorAccId = originalSale.vendor.account.id;
            const vendorBalanceDelta = originalSale.vendor.category === "DEBIT" ? -vendorRefundAmount : vendorRefundAmount;

            await tx.ledgerEntry.create({
                data: {
                    accountId: vendorAccId,
                    entryType: "REFUND",
                    debit: 0,
                    credit: vendorRefundAmount,
                    transactionDate: businessDate,
                    saleId: originalSale.id,
                    invoiceId: originalSale.invoiceId,
                    remarks: `Vendor refund (Net Base) - Fee: ${fee}`
                }
            });

            await tx.account.update({
                where: { id: vendorAccId },
                data: { balance: { increment: vendorBalanceDelta } }
            });

            /* CUSTOMER LEDGER */
            if (String(originalSale.paymentType).toUpperCase() === "CREDIT" && originalSale.customer?.account) {
                const custAccId = originalSale.customer.account.id;
                await tx.ledgerEntry.create({
                    data: {
                        accountId: custAccId,
                        entryType: "REFUND",
                        debit: 0,
                        credit: netRefundToCustomer,
                        transactionDate: businessDate,
                        saleId: originalSale.id,
                        invoiceId: originalSale.invoiceId,
                        remarks: `Customer refund (Net Base) - Fee: ${fee}, Srv: ${charges}`
                    }
                });
                await tx.account.update({
                    where: { id: custAccId },
                    data: { balance: { decrement: netRefundToCustomer } }
                });
            }

            /* CREATE REFUND RECORD */
            const refund = await tx.refund.create({
                data: {
                    saleId: originalSale.id,
                    originalSaleAmount: originalSell,
                    customerRefundAmount: customerRefundAmount,
                    vendorRefundAmount: vendorRefundAmount,
                    refundFee: fee,
                    cancellationCharges: charges,
                    netRefundToCustomer: netRefundToCustomer,
                    netCostToUs: charges,
                    refundReason: refundReason || null,
                    remarks: remarks || null,
                    refundDate: businessDate,
                    status: "COMPLETED",
                    processedById: req.user.id
                }
            });

            await tx.sale.update({
                where: { id: originalSale.id },
                data: { status: "REFUNDED", paymentStatus: "PAID" }
            });

            return refund;
        }, { timeout: 20000 });

        return res.status(201).json({ success: true, data: result });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});
/* ======================= UPDATE REFUND ======================= */
router.put("/:refundId", authenticate, async (req, res) => {
    const { refundId } = req.params;
    const { refundDate, refundFee, serviceCharges, refundReason, remarks } = req.body;

    try {
        const result = await prisma.$transaction(async (tx) => {
            const existingRefund = await tx.refund.findUnique({
                where: { id: refundId },
                include: { sale: { include: { vendor: { include: { account: true } }, customer: { include: { account: true } }, invoice: true } } }
            });

            if (!existingRefund) throw new Error("Refund not found");

            const originalSale = existingRefund.sale;
            const originalNet = Number(originalSale.netPrice);

            const newFee = refundFee !== undefined ? Number(refundFee) : existingRefund.refundFee;
            const newCharges = serviceCharges !== undefined ? Number(serviceCharges) : existingRefund.cancellationCharges;

            // Updated Calculation based on NET price
            const newVendorRefund = originalNet - newFee;
            const newCustomerRefundAmount = originalNet - newFee;
            const newNetRefundToCustomer = newCustomerRefundAmount - newCharges;

            const vendorDelta = newVendorRefund - Number(existingRefund.vendorRefundAmount);
            const customerDelta = newNetRefundToCustomer - Number(existingRefund.netRefundToCustomer);

            const businessDate = refundDate ? new Date(refundDate) : existingRefund.refundDate;

            /* UPDATE VENDOR LEDGER */
            if (vendorDelta !== 0) {
                const vendorAccId = originalSale.vendor.account.id;
                const vendorLedger = await tx.ledgerEntry.findFirst({
                    where: { saleId: originalSale.id, accountId: vendorAccId, entryType: "REFUND" }
                });
                if (vendorLedger) {
                    await tx.ledgerEntry.update({
                        where: { id: vendorLedger.id },
                        data: { credit: newVendorRefund, transactionDate: businessDate }
                    });
                }
                const vendorBalanceDelta = originalSale.vendor.category === "DEBIT" ? -vendorDelta : vendorDelta;
                await tx.account.update({
                    where: { id: vendorAccId },
                    data: { balance: { increment: vendorBalanceDelta } }
                });
            }

            /* UPDATE CUSTOMER LEDGER */
            if (customerDelta !== 0 && originalSale.customer?.account) {
                const custAccId = originalSale.customer.account.id;
                const customerLedger = await tx.ledgerEntry.findFirst({
                    where: { saleId: originalSale.id, accountId: custAccId, entryType: "REFUND" }
                });
                if (customerLedger) {
                    await tx.ledgerEntry.update({
                        where: { id: customerLedger.id },
                        data: { credit: newNetRefundToCustomer, transactionDate: businessDate }
                    });
                }
                await tx.account.update({
                    where: { id: custAccId },
                    data: { balance: { decrement: customerDelta } }
                });
            }

            /* UPDATE REFUND RECORD */
            return await tx.refund.update({
                where: { id: refundId },
                data: {
                    vendorRefundAmount: newVendorRefund,
                    customerRefundAmount: newCustomerRefundAmount,
                    netRefundToCustomer: newNetRefundToCustomer,
                    refundFee: newFee,
                    cancellationCharges: newCharges,
                    netCostToUs: newCharges,
                    refundDate: businessDate,
                    refundReason: refundReason ?? existingRefund.refundReason,
                    remarks: remarks ?? existingRefund.remarks
                }
            });
        });

        return res.json({ success: true, data: result });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});


router.delete("/:refundId", authenticate, async (req, res) => {
    const { refundId } = req.params;

    try {
        const result = await prisma.$transaction(async (tx) => {
            /* ====================================================
               1️⃣ LOAD REFUND WITH ALL RELATIONS
            ==================================================== */
            const refund = await tx.refund.findUnique({
                where: { id: refundId },
                include: {
                    sale: {
                        include: {
                            vendor: { include: { account: true } },
                            customer: { include: { account: true } },
                            invoice: true
                        }
                    }
                }
            });

            if (!refund) throw new Error("Refund record not found");

            const sale = refund.sale;
            const vendor = sale.vendor;
            const customer = sale.customer;
            const invoice = sale.invoice;

            /* ====================================================
               2️⃣ REVERSE VENDOR ACCOUNT BALANCE
            ==================================================== */
            if (vendor?.account) {
                const vendorRefundAmt = Number(refund.vendorRefundAmount);
                // If it was a DEBIT vendor, we added balance during refund, so we subtract now.
                // If it was CREDIT, we subtracted during refund, so we add now.
                const vendorReverseDelta = vendor.category === "DEBIT" ? vendorRefundAmt : -vendorRefundAmt;

                await tx.account.update({
                    where: { id: vendor.account.id },
                    data: { balance: { increment: vendorReverseDelta } }
                });
            }

            /* ====================================================
               3️⃣ REVERSE CUSTOMER ACCOUNT BALANCE
            ==================================================== */
            // Check if it was a CREDIT sale (where balance was actually affected)
            const isCredit = String(sale.paymentType).toUpperCase() === "CREDIT";
            if (isCredit && customer?.account) {
                const customerRefundAmt = Number(refund.netRefundToCustomer);

                // Refund decreased their debt (credit), so deletion must increase it back (debit)
                await tx.account.update({
                    where: { id: customer.account.id },
                    data: { balance: { increment: customerRefundAmt } }
                });
            }

            /* ====================================================
               4️⃣ REMOVE LEDGER ENTRIES
            ==================================================== */
            // Delete all ledger entries associated with this specific sale that are type "REFUND"
            await tx.ledgerEntry.deleteMany({
                where: {
                    saleId: sale.id,
                    entryType: "REFUND"
                }
            });

            /* ====================================================
               5️⃣ RE-CALCULATE INVOICE TOTALS
            ==================================================== */
            if (invoice) {
                const originalNet = Number(sale.netPrice);
                const originalSell = Number(sale.sellPrice);

                await tx.salesInvoice.update({
                    where: { id: invoice.id },
                    data: {
                        totalNet: { increment: originalNet },
                        totalSell: { increment: originalSell },
                        totalProfit: { increment: (originalSell - originalNet) }
                    }
                });
            }

            /* ====================================================
               6️⃣ RESTORE SALE STATUS
            ==================================================== */
            await tx.sale.update({
                where: { id: sale.id },
                data: {
                    status: "COMPLETED", // Reverting status from REFUNDED to COMPLETED
                    paymentStatus: "PAID"
                }
            });

            /* ====================================================
               7️⃣ DELETE THE REFUND RECORD
            ==================================================== */
            await tx.refund.delete({
                where: { id: refundId }
            });

            return { message: "Refund fully reversed and deleted" };
        }, { timeout: 20000 });

        return res.json({
            success: true,
            message: result.message
        });

    } catch (err) {
        console.error(err);
        return res.status(400).json({
            success: false,
            error: err.message || "Failed to delete refund"
        });
    }
});

export default router;