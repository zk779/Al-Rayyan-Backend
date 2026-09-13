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
const isTabbyOrTamaraCustomer = (customer) =>
    customer?.customerType === "TABBY_OR_TAMARA";

// Get-or-create the singleton CASH account — same convention used by
// sales.js / expenseRoutes.js / Vendorcustomerpayment.js.
async function getCashAccount(tx) {
    let cash = await tx.account.findFirst({ where: { type: "CASH" } });
    if (!cash) {
        cash = await tx.account.create({
            data: { name: "Cash Account", type: "CASH", balance: 0 },
        });
    }
    return cash;
}

function resolveDateFilter(startDate, endDate, timeZone) {
    if (!startDate && !endDate) return null;

    const filter = {};

    if (startDate) {
        const range = localDayRangeToUtc(startDate, timeZone);
        if (range) filter.gte = range.start;
    }

    if (endDate) {
        const range = localDayRangeToUtc(endDate, timeZone);
        if (range) filter.lte = range.end;
    }

    return Object.keys(filter).length ? filter : null;
}

/* ======================= LIST REFUNDS ======================= */
router.get("/", authenticate, async (req, res) => {
    const {
        page = 1,
        limit = 20,
        status,
        saleId,
        startDate,
        endDate,
        tz,
        sortBy = "createdAt",
        sortOrder = "desc",
        search,
        processedById
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    // Each condition below is pushed into `filters` and combined with AND,
    // so search + status + saleId + date range + processedBy can all be
    // applied together.
    const filters = [];

    if (status) {
        filters.push({ status: status.toUpperCase() });
    }

    if (saleId) {
        filters.push({ saleId });
    }

    if (processedById) {
        filters.push({ processedById });
    }

    // ── Resolve local-timezone-aware date filter ──
    const dateFilter = resolveDateFilter(startDate, endDate, tz);
    if (dateFilter) {
        filters.push({ refundDate: dateFilter });
    }

    // Search across: the refund's own remarks/refundReason, the linked
    // sale's documentNo, or that sale's invoice's invoiceNo.
    if (search) {
        filters.push({
            OR: [
                { remarks: { contains: search, mode: "insensitive" } },
                { refundReason: { contains: search, mode: "insensitive" } },
                { sale: { documentNo: { contains: search, mode: "insensitive" } } },
                { sale: { invoice: { invoiceNo: { contains: search, mode: "insensitive" } } } }
            ]
        });
    }

    const where = filters.length > 0 ? { AND: filters } : {};

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
                            documentNo: true,
                            vendor: { select: { id: true, vendorName: true } },
                            // customerType exposed so the UI can flag TABBY/TAMARA
                            // pass-through refunds (paid out in cash, not credited
                            // back to this customer's receivable balance).
                            customer: { select: { id: true, customerName: true, customerType: true } },
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

            /* ====================================================
               1️⃣ LOAD & VALIDATE ORIGINAL SALE
            ==================================================== */
            const originalSale = await tx.sale.findUnique({
                where: { id: saleId },
                include: {
                    vendor: { include: { account: true } },
                    customer: { include: { account: true } },
                    invoice: true,
                    payments: {                              // SalePayment legs (for PARTIAL sales)
                        include: {
                            customer: { include: { account: true } },
                        },
                    },
                }
            });

            if (!originalSale) throw new Error("Original sale not found");

            // Only check refund record — original sale status stays untouched
            const existingRefund = await tx.refund.findFirst({ where: { saleId } });
            if (existingRefund) throw new Error("A refund already exists for this sale");

            /* ====================================================
               2️⃣ CALCULATE REFUND AMOUNTS
            ==================================================== */
            const originalNet = Number(originalSale.netPrice);
            const originalSell = Number(originalSale.sellPrice);

            const vendorRefundAmount = originalNet - fee;
            const customerRefundAmount = originalNet - fee;
            const netRefundToCustomer = customerRefundAmount - charges;
            const netCostToUs = charges;

            /* ====================================================
               3️⃣ CREATE REFUND RECORD (linked to original sale)
               Created FIRST so refund.id is ready to stamp as a proper
               `refundId` reference onto every ledger entry below, and
               onto the negative mirror sale's refundRecordId.
            ==================================================== */
            const refund = await tx.refund.create({
                data: {
                    saleId: originalSale.id,
                    originalSaleAmount: originalSell,
                    customerRefundAmount: customerRefundAmount,
                    vendorRefundAmount: vendorRefundAmount,
                    refundFee: fee,
                    cancellationCharges: charges,
                    netRefundToCustomer: netRefundToCustomer,
                    netCostToUs: netCostToUs,
                    refundReason: refundReason || null,
                    remarks: remarks || null,
                    refundDate: businessDate,
                    status: "COMPLETED",
                    processedById: req.user.id,
                }
            });

            /* ====================================================
               4️⃣ VENDOR LEDGER ENTRY + BALANCE UPDATE
            ==================================================== */
            const vendorAccId = originalSale.vendor.account.id;
            const vendorBalDelta = originalSale.vendor.category === "DEBIT"
                ? -vendorRefundAmount
                : vendorRefundAmount;

            await tx.ledgerEntry.create({
                data: {
                    accountId: vendorAccId,
                    entryType: "REFUND",
                    debit: vendorRefundAmount,
                    credit: 0,
                    transactionDate: businessDate,
                    saleId: originalSale.id,
                    invoiceId: originalSale.invoiceId,
                    refundId: refund.id,
                    remarks: `Vendor refund (Net Base) - Fee: ${fee} | Doc: ${originalSale.documentNo || originalSale.id} | Inv: ${originalSale.invoice?.invoiceNo || "-"}`,
                }
            });

            await tx.account.update({
                where: { id: vendorAccId },
                data: { balance: { increment: vendorBalDelta } }
            });
            const pt = String(originalSale.paymentType).toUpperCase();
            const isCredit = pt === "CREDIT";

            const partialCreditLeg = pt === "PARTIAL"
                ? (originalSale.payments || []).find(
                    l => String(l.method).toUpperCase() === "CREDIT"
                )
                : null;

            // Resolve which customer account (if any) actually carries the
            // receivable for this sale — either the direct CREDIT customer,
            // or the CREDIT leg's customer for a PARTIAL sale.
            const refundCustomer = isCredit
                ? originalSale.customer
                : (partialCreditLeg ? partialCreditLeg.customer : null);

            const refRef = `Doc: ${originalSale.documentNo || originalSale.id} | Inv: ${originalSale.invoice?.invoiceNo || "-"} | PAX: ${originalSale.paxName || "-"}`;

            if ((isCredit || partialCreditLeg) && refundCustomer && isTabbyOrTamaraCustomer(refundCustomer)) {
                // Pass-through refund — paid to the real traveler in cash,
                // Tabby/Tamara's receivable is left completely untouched.
                const cashAccount = await getCashAccount(tx);

                await tx.ledgerEntry.create({
                    data: {
                        accountId: cashAccount.id,
                        entryType: "REFUND",
                        debit: netRefundToCustomer,
                        credit: 0,
                        transactionDate: businessDate,
                        saleId: originalSale.id,
                        invoiceId: originalSale.invoiceId,
                        refundId: refund.id,
                        remarks: `TABBY/TAMARA pass-through refund — paid directly to traveler in cash, does NOT affect ${refundCustomer.customerName}'s receivable balance | ${refRef} | Fee: ${fee}, Srv: ${charges} | Reason: ${refundReason || "-"}`,
                    }
                });

                await tx.account.update({
                    where: { id: cashAccount.id },
                    data: { balance: { increment: -netRefundToCustomer } }
                });
            } else if ((isCredit || partialCreditLeg) && refundCustomer?.account) {
                const custAccId = refundCustomer.account.id;

                await tx.ledgerEntry.create({
                    data: {
                        accountId: custAccId,
                        entryType: "REFUND",
                        debit: 0,
                        credit: netRefundToCustomer,
                        transactionDate: businessDate,
                        saleId: originalSale.id,
                        invoiceId: originalSale.invoiceId,
                        refundId: refund.id,
                        remarks: `Customer refund - ${netRefundToCustomer} (Fee: ${fee}, Srv: ${charges}) | ${refRef} | Reason: ${refundReason || "-"}`,
                    }
                });

                await tx.account.update({
                    where: { id: custAccId },
                    data: { balance: { decrement: netRefundToCustomer } }
                });
            }

            /* ====================================================
               6️⃣ CREATE NEGATIVE MIRROR SALE
               Original sale is completely untouched.
               Negative sale carries the REFUNDED status and links
               back to the Refund record via refundRecordId.
            ==================================================== */
            const negativeSale = await tx.sale.create({
                data: {
                    invoiceId: originalSale.invoiceId,
                    airlineId: originalSale.airlineId,
                    vendorId: originalSale.vendorId,
                    customerId: originalSale.customerId || (partialCreditLeg?.customerId || null),

                    documentNo: `REF-${originalSale.documentNo || originalSale.id}`,
                    pnr: originalSale.pnr || null,
                    paxName: originalSale.paxName || null,
                    routeType: originalSale.routeType || null,
                    tripType: originalSale.tripType || null,
                    departureDate: originalSale.departureDate || null,
                    returnDate: originalSale.returnDate || null,
                    destinations: originalSale.destinations || null,

                    netPrice: -originalNet,
                    sellPrice: -originalSell,
                    profit: -(Number(originalSale.profit || 0)),
                    vatAmount: -(Number(originalSale.vatAmount || 0)),
                    paxVat: -(Number(originalSale.paxVat || 0)),
                    miscCharges: -(Number(originalSale.miscCharges || 0)),
                    paidAmount: -(Number(originalSale.paidAmount || 0)),

                    paymentType: originalSale.paymentType,
                    paymentStatus: "PAID",
                    status: "REFUNDED",

                    refundRecordId: refund.id,

                    remarks: `REFUND | Original Doc: ${originalSale.documentNo || originalSale.id} | Reason: ${refundReason || "-"}`,
                }
            });

            /* ====================================================
               7️⃣ UPDATE INVOICE TOTALS
            ==================================================== */
            await tx.salesInvoice.update({
                where: { id: originalSale.invoiceId },
                data: {
                    totalNet: { increment: -originalNet },
                    totalSell: { increment: -originalSell },
                    totalProfit: { increment: -(Number(originalSale.profit || 0)) },
                }
            });

            return { refund, negativeSaleId: negativeSale.id };
        }, { timeout: 20000 });

        return res.status(201).json({ success: true, data: result });

    } catch (err) {
        console.error(err);
        return res.status(400).json({ success: false, error: err.message });
    }
});
/* ──────────────────────────────────────────────────────
   HELPER: retry a transaction on write-conflict/deadlock
   errors (Prisma error code P2034), with a small backoff
   between attempts.
   ────────────────────────────────────────────────────── */
async function runWithRetry(fn, retries = 3) {
	for (let i = 0; i < retries; i++) {
		try {
			return await fn();
		} catch (err) {
			const isConflict = err.code === "P2034" || /write conflict|deadlock/i.test(err.message || "");
			if (isConflict && i < retries - 1) {
				await new Promise(r => setTimeout(r, 100 * (i + 1))); // 100ms, 200ms, ...
				continue;
			}
			throw err;
		}
	}
}

router.put("/:refundId", authenticate, async (req, res) => {
    const { refundId } = req.params;
    const { refundDate, refundFee, serviceCharges, refundReason, remarks } = req.body;

    try {
        const result = await runWithRetry(() =>
            prisma.$transaction(async (tx) => {
                const existingRefund = await tx.refund.findUnique({
                    where: { id: refundId },
                    include: {
                        sale: {
                            include: {
                                vendor: { include: { account: true } },
                                customer: { include: { account: true } },
                                invoice: true,
                                payments: {                              // SalePayment legs (for PARTIAL sales)
                                    include: {
                                        customer: { include: { account: true } },
                                    },
                                },
                            }
                        }
                    }
                });

                if (!existingRefund) throw new Error("Refund not found");

                const originalSale = existingRefund.sale;
                const originalNet  = Number(originalSale.netPrice);

                const newFee     = refundFee        !== undefined ? Number(refundFee)        : Number(existingRefund.refundFee);
                const newCharges = serviceCharges   !== undefined ? Number(serviceCharges)   : Number(existingRefund.cancellationCharges);

                const newVendorRefund        = originalNet - newFee;
                const newCustomerRefundAmount = originalNet - newFee;
                const newNetRefundToCustomer  = newCustomerRefundAmount - newCharges;

                const vendorDelta   = newVendorRefund        - Number(existingRefund.vendorRefundAmount);
                const customerDelta = newNetRefundToCustomer - Number(existingRefund.netRefundToCustomer);

                const businessDate = refundDate ? new Date(refundDate) : existingRefund.refundDate;

                /* ====================================================
                   1️⃣ UPDATE VENDOR LEDGER + BALANCE
                ==================================================== */
                if (vendorDelta !== 0) {
                    const vendorAccId = originalSale.vendor.account.id;

                    const vendorLedger = await tx.ledgerEntry.findFirst({
                        where: { saleId: originalSale.id, accountId: vendorAccId, entryType: "REFUND" }
                    });

                    if (vendorLedger) {
                        await tx.ledgerEntry.update({
                            where: { id: vendorLedger.id },
                            data:  { debit: newVendorRefund, transactionDate: businessDate }
                        });
                    }

                    const vendorBalanceDelta = originalSale.vendor.category === "DEBIT"
                        ? -vendorDelta
                        :  vendorDelta;

                    await tx.account.update({
                        where: { id: vendorAccId },
                        data:  { balance: { increment: vendorBalanceDelta } }
                    });
                }
                const pt = String(originalSale.paymentType).toUpperCase();
                const isCredit = pt === "CREDIT";

                const partialCreditLeg = pt === "PARTIAL"
                    ? (originalSale.payments || []).find(
                        l => String(l.method).toUpperCase() === "CREDIT"
                    )
                    : null;

                const refundCustomer = isCredit
                    ? originalSale.customer
                    : (partialCreditLeg ? partialCreditLeg.customer : null);

                if (customerDelta !== 0 && (isCredit || partialCreditLeg)) {
                    const cashAccount = await getCashAccount(tx);
                    const candidateAccountIds = [refundCustomer?.account?.id, cashAccount.id].filter(Boolean);

                    const custSideLedger = candidateAccountIds.length
                        ? await tx.ledgerEntry.findFirst({
                            where: { saleId: originalSale.id, entryType: "REFUND", accountId: { in: candidateAccountIds } }
                        })
                        : null;

                    if (custSideLedger) {
                        const isCashEntry = custSideLedger.accountId === cashAccount.id;
                        const refRef = `Doc: ${originalSale.documentNo || originalSale.id} | Inv: ${originalSale.invoice?.invoiceNo || "-"} | PAX: ${originalSale.paxName || "-"}`;

                        await tx.ledgerEntry.update({
                            where: { id: custSideLedger.id },
                            data: isCashEntry
                                ? {
                                    debit: newNetRefundToCustomer,
                                    transactionDate: businessDate,
                                    remarks: `TABBY/TAMARA pass-through refund — paid directly to traveler in cash, does NOT affect ${refundCustomer?.customerName || "customer"}'s receivable balance | ${refRef} | Fee: ${newFee}, Srv: ${newCharges} | Reason: ${refundReason ?? existingRefund.refundReason ?? "-"}`,
                                }
                                : {
                                    credit: newNetRefundToCustomer,
                                    transactionDate: businessDate,
                                    remarks: `Customer refund - ${newNetRefundToCustomer} (Fee: ${newFee}, Srv: ${newCharges}) | ${refRef} | Reason: ${refundReason ?? existingRefund.refundReason ?? "-"}`,
                                }
                        });
                        await tx.account.update({
                            where: { id: custSideLedger.accountId },
                            data:  { balance: { increment: -customerDelta } }
                        });
                    }
                }

                const negativeSale = await tx.sale.findFirst({
                    where: { refundRecordId: refundId }
                });

                if (negativeSale && customerDelta !== 0) {
                    await tx.sale.update({
                        where: { id: negativeSale.id },
                        data: {
                            paidAmount: { increment: -customerDelta },
                        }
                    });
                }

                /* ====================================================
                   4️⃣ UPDATE REFUND RECORD
                ==================================================== */
                return await tx.refund.update({
                    where: { id: refundId },
                    data: {
                        vendorRefundAmount:   newVendorRefund,
                        customerRefundAmount: newCustomerRefundAmount,
                        netRefundToCustomer:  newNetRefundToCustomer,
                        refundFee:            newFee,
                        cancellationCharges:  newCharges,
                        netCostToUs:          newCharges,
                        refundDate:           businessDate,
                        refundReason:         refundReason  ?? existingRefund.refundReason,
                        remarks:              remarks        ?? existingRefund.remarks,
                    }
                });
            }, { timeout: 20000, maxWait: 10000 })
        );

        return res.json({ success: true, data: result });

    } catch (err) {
        console.error(err);
        return res.status(400).json({ success: false, error: err.message });
    }
});

router.delete("/:refundId", authenticate, async (req, res) => {
    const { refundId } = req.params;

    try {
        const result = await runWithRetry(() =>
            prisma.$transaction(async (tx) => {

                /* ====================================================
                   1️⃣ LOAD REFUND WITH ALL RELATIONS
                ==================================================== */
                const refund = await tx.refund.findUnique({
                    where: { id: refundId },
                    include: {
                        sale: {
                            include: {
                                vendor:   { include: { account: true } },
                                customer: { include: { account: true } },
                                invoice:  true,
                                payments: {                              // SalePayment legs (for PARTIAL sales)
                                    include: {
                                        customer: { include: { account: true } },
                                    },
                                },
                            }
                        }
                    }
                });

                if (!refund) throw new Error("Refund record not found");

                const originalSale = refund.sale;
                const vendor       = originalSale.vendor;

                /* ====================================================
                   2️⃣ REVERSE VENDOR ACCOUNT BALANCE
                ==================================================== */
                if (vendor?.account) {
                    const vendorRefundAmt    = Number(refund.vendorRefundAmount);
                    const vendorReverseDelta = vendor.category === "DEBIT"
                        ?  vendorRefundAmt
                        : -vendorRefundAmt;

                    await tx.account.update({
                        where: { id: vendor.account.id },
                        data:  { balance: { increment: vendorReverseDelta } }
                    });
                }
                const pt = String(originalSale.paymentType).toUpperCase();
                const isCredit = pt === "CREDIT";

                const partialCreditLeg = pt === "PARTIAL"
                    ? (originalSale.payments || []).find(
                        l => String(l.method).toUpperCase() === "CREDIT"
                    )
                    : null;

                const refundCustomer = isCredit
                    ? originalSale.customer
                    : (partialCreditLeg ? partialCreditLeg.customer : null);

                if (isCredit || partialCreditLeg) {
                    const cashAccountForReversal = await getCashAccount(tx);
                    const candidateAccountIds = [refundCustomer?.account?.id, cashAccountForReversal.id].filter(Boolean);

                    const custSideLedger = candidateAccountIds.length
                        ? await tx.ledgerEntry.findFirst({
                            where: { saleId: originalSale.id, entryType: "REFUND", accountId: { in: candidateAccountIds } }
                        })
                        : null;

                    if (custSideLedger) {
                        const customerRefundAmt = Number(refund.netRefundToCustomer);

                        await tx.account.update({
                            where: { id: custSideLedger.accountId },
                            data:  { balance: { increment: customerRefundAmt } }
                        });
                    }
                }

                /* ====================================================
                   4️⃣ REMOVE REFUND LEDGER ENTRIES
                ==================================================== */
                await tx.ledgerEntry.deleteMany({
                    where: {
                        saleId:    originalSale.id,
                        entryType: "REFUND"
                    }
                });

                /* ====================================================
                   5️⃣ FIND & DELETE THE NEGATIVE MIRROR SALE
                   Try refundRecordId first (new refunds, reliable direct
                   link). Fall back to documentNo matching for refunds
                   created before that field existed.
                   This also reverses the invoice totals automatically
                   since the negative sale is removed from the invoice.
                ==================================================== */
                let negativeSale = await tx.sale.findFirst({
                    where: { refundRecordId: refundId }
                });

                if (!negativeSale) {
                    negativeSale = await tx.sale.findFirst({
                        where: {
                            invoiceId:  originalSale.invoiceId,
                            documentNo: `REF-${originalSale.documentNo || originalSale.id}`,
                            status:     "REFUNDED",
                        }
                    });
                }

                if (negativeSale) {
                    // Reverse the invoice totals BEFORE deleting the negative
                    // sale — we need its amounts, and once deleted we can't
                    // read them back.
                    await tx.salesInvoice.update({
                        where: { id: originalSale.invoiceId },
                        data: {
                            totalNet:    { increment: -Number(negativeSale.netPrice)  },  // netPrice was negative, so -negative = positive
                            totalSell:   { increment: -Number(negativeSale.sellPrice) },
                            totalProfit: { increment: -Number(negativeSale.profit)    },
                        }
                    });

                    await tx.sale.delete({
                        where: { id: negativeSale.id }
                    });
                }

                /* ====================================================
                   6️⃣ DELETE THE REFUND RECORD
                   Original sale is left completely untouched.
                   Negative sale (if any) is already deleted above, so
                   there's no dangling refundRecordId reference left.
                ==================================================== */
                await tx.refund.delete({
                    where: { id: refundId }
                });

                return { message: "Refund fully reversed and deleted" };
            }, { timeout: 20000, maxWait: 10000 })
        );

        return res.json({ success: true, message: result.message });

    } catch (err) {
        console.error(err);
        return res.status(400).json({
            success: false,
            error: err.message || "Failed to delete refund"
        });
    }
});

export default router;