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

/* ====================================================
   REFUND PAYOUT RESOLUTION
   ----------------------------------------------------
   A refund's customer-side amount (netRefundToCustomer) can be settled
   three ways, independent of how the original sale was paid:
     - CUSTOMER_LEDGER — credited to the sale's own CREDIT customer
       (or PARTIAL sale's CREDIT-leg customer). Rejected for a
       TABBY_OR_TAMARA customer — see isTabbyOrTamaraCustomer above.
     - CASH           — paid out of the CASH account.
     - BANK_TRANSFER  — paid out of a specific bank's account
       (defaults to the sale's own bankId if one isn't given).
   Callers may pass `refundType` (+ `bankId` for BANK_TRANSFER)
   explicitly; if omitted, inferDefaultRefundType() picks a sensible
   default from the sale/customer so older callers keep working.
==================================================== */
function inferDefaultRefundType(originalSale, refundCustomer) {
    if (refundCustomer && isTabbyOrTamaraCustomer(refundCustomer)) return "CASH";
    if (refundCustomer?.account) return "CUSTOMER_LEDGER";
    const pt = String(originalSale.paymentType).toUpperCase();
    return pt === "BANK_TRANSFER" ? "BANK_TRANSFER" : "CASH";
}

async function resolveRefundPayoutTarget(tx, { originalSale, refundCustomer, refundType, bankId }) {
    const type = refundType || inferDefaultRefundType(originalSale, refundCustomer);

    if (type === "CASH") {
        const cash = await getCashAccount(tx);
        return { type, accountId: cash.id, bankId: null, label: "Cash" };
    }

    if (type === "BANK_TRANSFER") {
        const resolvedBankId = bankId || originalSale.bankId;
        if (!resolvedBankId) {
            throw new Error("bankId is required for a BANK_TRANSFER refund");
        }
        const bank = await tx.bank.findUnique({ where: { id: resolvedBankId }, include: { account: true } });
        if (!bank) throw new Error("Bank account not found");
        return { type, accountId: bank.account.id, bankId: bank.id, label: `Bank - ${bank.bankName}` };
    }

    if (type === "CUSTOMER_LEDGER") {
        if (refundCustomer && isTabbyOrTamaraCustomer(refundCustomer)) {
            throw new Error(
                `${refundCustomer.customerName} is a TABBY/TAMARA account — refund must be paid out as CASH or BANK_TRANSFER, not credited to their receivable balance`
            );
        }
        if (!refundCustomer?.account) {
            throw new Error("This sale has no linked customer account to credit — choose CASH or BANK_TRANSFER instead");
        }
        return { type, accountId: refundCustomer.account.id, bankId: null, label: refundCustomer.customerName };
    }

    throw new Error(`Unknown refundType "${type}"`);
}

function buildPayoutRemarks(target, originalSale, refundCustomer, { fee, charges, refundReason }) {
    const ref = `Doc: ${originalSale.documentNo || originalSale.id} | Inv: ${originalSale.invoice?.invoiceNo || "-"} | PAX: ${originalSale.paxName || "-"}`;
    const reasonPart = `Reason: ${refundReason || "-"}`;
    const feePart = `Fee: ${fee}, Srv: ${charges}`;

    if (target.type === "CUSTOMER_LEDGER") {
        return `Customer refund credited to ${target.label} (${feePart}) | ${ref} | ${reasonPart}`;
    }

    const passthroughNote = refundCustomer && isTabbyOrTamaraCustomer(refundCustomer)
        ? ` — does NOT affect ${refundCustomer.customerName}'s receivable balance`
        : "";

    return target.type === "CASH"
        ? `Refund paid out in CASH${passthroughNote} (${feePart}) | ${ref} | ${reasonPart}`
        : `Refund paid out via BANK TRANSFER (${target.label})${passthroughNote} (${feePart}) | ${ref} | ${reasonPart}`;
}

// Fallback for refunds created before payoutAccountId was stamped —
// finds whichever of the customer's account or the cash account actually
// carries this sale's REFUND ledger entry (bank-based refunds didn't
// exist before this field, so they need no fallback).
async function resolveLegacyPayoutAccountId(tx, { originalSale, refundCustomer }) {
    const cash = await getCashAccount(tx);
    const candidateAccountIds = [refundCustomer?.account?.id, cash.id].filter(Boolean);
    if (!candidateAccountIds.length) return null;

    const entry = await tx.ledgerEntry.findFirst({
        where: { saleId: originalSale.id, entryType: "REFUND", accountId: { in: candidateAccountIds } }
    });
    return entry?.accountId || null;
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
                    },
                    // Present only when refundType is BANK_TRANSFER.
                    bank: { select: { id: true, bankName: true } }
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
                },
                // Present only when refundType is BANK_TRANSFER.
                bank: { select: { id: true, bankName: true, accountNumber: true } }
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
        remarks,
        refundType,   // optional: "CUSTOMER_LEDGER" | "CASH" | "BANK_TRANSFER" — defaults if omitted
        bankId,       // required for refundType "BANK_TRANSFER" unless the sale itself was paid via a bank
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
               3️⃣ RESOLVE WHO/WHAT GETS THE CUSTOMER-SIDE PAYOUT
               (validated BEFORE creating anything, so a bad refundType/
               bankId fails fast and rolls back the whole transaction)
            ==================================================== */
            const pt = String(originalSale.paymentType).toUpperCase();
            const isCredit = pt === "CREDIT";

            const partialCreditLeg = pt === "PARTIAL"
                ? (originalSale.payments || []).find(
                    l => String(l.method).toUpperCase() === "CREDIT"
                )
                : null;

            // Resolve which customer (if any) actually carries the
            // receivable for this sale — either the direct CREDIT customer,
            // or the CREDIT leg's customer for a PARTIAL sale. Only relevant
            // for a CUSTOMER_LEDGER payout or to detect TABBY_OR_TAMARA.
            const refundCustomer = isCredit
                ? originalSale.customer
                : (partialCreditLeg ? partialCreditLeg.customer : null);

            const payoutTarget = await resolveRefundPayoutTarget(tx, {
                originalSale,
                refundCustomer,
                refundType,
                bankId,
            });

            /* ====================================================
               4️⃣ CREATE REFUND RECORD (linked to original sale)
               Created before the ledger entries so refund.id is ready
               to stamp as a proper `refundId` reference on each of them,
               and onto the negative mirror sale's refundRecordId.
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
                    refundType: payoutTarget.type,
                    payoutAccountId: payoutTarget.accountId,
                    bankId: payoutTarget.bankId,
                }
            });

            /* ====================================================
               5️⃣ VENDOR LEDGER ENTRY + BALANCE UPDATE
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

            /* ====================================================
               6️⃣ CUSTOMER-SIDE PAYOUT LEDGER ENTRY + BALANCE UPDATE
               CUSTOMER_LEDGER credits the customer's receivable (a
               "credit" entry); CASH/BANK_TRANSFER is money actually
               leaving that account (a "debit" entry) — either way the
               account's balance moves down by netRefundToCustomer.
            ==================================================== */
            await tx.ledgerEntry.create({
                data: {
                    accountId: payoutTarget.accountId,
                    entryType: "REFUND",
                    debit: payoutTarget.type === "CUSTOMER_LEDGER" ? 0 : netRefundToCustomer,
                    credit: payoutTarget.type === "CUSTOMER_LEDGER" ? netRefundToCustomer : 0,
                    transactionDate: businessDate,
                    saleId: originalSale.id,
                    invoiceId: originalSale.invoiceId,
                    refundId: refund.id,
                    remarks: buildPayoutRemarks(payoutTarget, originalSale, refundCustomer, { fee, charges, refundReason }),
                }
            });

            await tx.account.update({
                where: { id: payoutTarget.accountId },
                data: { balance: { increment: -netRefundToCustomer } }
            });

            /* ====================================================
               7️⃣ CREATE NEGATIVE MIRROR SALE
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
               8️⃣ UPDATE INVOICE TOTALS
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

                /* ====================================================
                   2️⃣ UPDATE CUSTOMER-SIDE PAYOUT LEDGER + BALANCE
                   Note: this edits fee/serviceCharges/date/reason only —
                   it does NOT change WHERE the refund was paid out to.
                   Changing refundType/bankId on an existing refund isn't
                   supported here (that would mean moving money from one
                   account to another); delete and recreate the refund if
                   the payout method itself was wrong.
                ==================================================== */
                if (customerDelta !== 0) {
                    const payoutAccountId = existingRefund.payoutAccountId
                        || (await resolveLegacyPayoutAccountId(tx, { originalSale, refundCustomer }));

                    const custSideLedger = payoutAccountId
                        ? await tx.ledgerEntry.findFirst({
                            where: { saleId: originalSale.id, entryType: "REFUND", accountId: payoutAccountId }
                        })
                        : null;

                    if (custSideLedger) {
                        // A payout-style entry (CASH/BANK_TRANSFER) carries its
                        // amount on `debit`; a CUSTOMER_LEDGER credit carries
                        // it on `credit` — infer from whichever is non-zero
                        // rather than trusting refundType alone, since older
                        // refunds may predate that field.
                        const isPayoutEntry = Number(custSideLedger.debit) > 0;
                        const inferredType = existingRefund.refundType || (isPayoutEntry ? "CASH" : "CUSTOMER_LEDGER");

                        let label = refundCustomer?.customerName || "Cash";
                        if (inferredType === "BANK_TRANSFER" && existingRefund.bankId) {
                            const bank = await tx.bank.findUnique({ where: { id: existingRefund.bankId } });
                            label = bank ? `Bank - ${bank.bankName}` : "Bank";
                        } else if (inferredType === "CASH") {
                            label = "Cash";
                        }

                        const payoutTarget = { type: inferredType, label };

                        await tx.ledgerEntry.update({
                            where: { id: custSideLedger.id },
                            data: isPayoutEntry
                                ? { debit: newNetRefundToCustomer, transactionDate: businessDate, remarks: buildPayoutRemarks(payoutTarget, originalSale, refundCustomer, { fee: newFee, charges: newCharges, refundReason: refundReason ?? existingRefund.refundReason }) }
                                : { credit: newNetRefundToCustomer, transactionDate: businessDate, remarks: buildPayoutRemarks(payoutTarget, originalSale, refundCustomer, { fee: newFee, charges: newCharges, refundReason: refundReason ?? existingRefund.refundReason }) }
                        });

                        // Same math regardless of payout type: a bigger refund
                        // always means more money leaving toward the traveler,
                        // so the account it's tracked against moves down by
                        // the same delta either way.
                        await tx.account.update({
                            where: { id: payoutAccountId },
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
                /* ====================================================
                   3️⃣ REVERSE CUSTOMER-SIDE PAYOUT ACCOUNT BALANCE
                   Reverses whichever account (the customer's receivable,
                   CASH, or a specific bank) actually absorbed this refund
                   — read straight from payoutAccountId for refunds created
                   after this field existed, falling back to a search for
                   older ones.
                ==================================================== */
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

                const payoutAccountId = refund.payoutAccountId
                    || (await resolveLegacyPayoutAccountId(tx, { originalSale, refundCustomer }));

                if (payoutAccountId) {
                    const customerRefundAmt = Number(refund.netRefundToCustomer);

                    await tx.account.update({
                        where: { id: payoutAccountId },
                        data:  { balance: { increment: customerRefundAmt } }
                    });
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