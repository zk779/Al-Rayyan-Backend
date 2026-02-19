import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

const router = express.Router();
const prisma = new PrismaClient();

/* ======================= AUTH ======================= */
async function authenticate(req, res, next) {
	const authHeader = req.headers.authorization;
	if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });

	try {
		const token = authHeader.split(" ")[1];
		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		const user = await prisma.user.findUnique({ where: { id: decoded.id } });
		if (!user || !user.isActive) return res.status(401).json({ error: "User inactive or removed" });
		req.user = decoded;
		next();
	} catch {
		res.status(401).json({ error: "Invalid or expired token" });
	}
}

/* ======================= GET ALL VENDORS ======================= */
router.get("/", authenticate, async (req, res) => {
	try {
		const { category, status, orderBy = "vendorDate", orderDir = "desc" } = req.query;

		const vendors = await prisma.vendor.findMany({
			where: {
				...(category && { category }),
				...(status !== undefined && { status: status === "true" }),
			},
			include: { account: { select: { balance: true } } },
			orderBy: { [["createdAt", "vendorDate"].includes(orderBy) ? orderBy : "vendorDate"]: orderDir === "asc" ? "asc" : "desc" },
		});

		res.json({ success: true, data: vendors });
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to fetch vendors" });
	}
});

/* ======================= GET VENDOR BY ID ======================= */
router.get("/:id", authenticate, async (req, res) => {
	try {
		const vendor = await prisma.vendor.findUnique({
			where: { id: req.params.id },
			include: {
				account: {
					include: {
						entries: { orderBy: { transactionDate: "asc" } },
					},
				},
			},
		});

		if (!vendor) return res.status(404).json({ success: false, error: "Vendor not found" });

		res.json({ success: true, data: vendor });
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to fetch vendor" });
	}
});

/* ======================= CREATE VENDOR ======================= */
router.post("/", authenticate, async (req, res) => {
	try {
		const { vendorName, category, vendorType, email, phone, address, openingBalance, vendorDate, status } = req.body;

		// Validation
		if (!vendorName || !category) {
			return res.status(400).json({ success: false, error: "vendorName and category are required" });
		}
		if (!["CREDIT", "DEBIT"].includes(category)) {
			return res.status(400).json({ success: false, error: "category must be CREDIT or DEBIT" });
		}

		const exists = await prisma.vendor.findFirst({ where: { vendorName } });
		if (exists) {
			return res.status(400).json({ success: false, error: "Vendor already exists" });
		}

		const opening = Number(openingBalance || 0);
		if (opening < 0 || isNaN(opening)) {
			return res.status(400).json({ success: false, error: "Invalid opening balance" });
		}

		const businessDate = vendorDate ? new Date(vendorDate) : new Date();
		const isDebit = category === "DEBIT";

		const vendor = await prisma.$transaction(async (tx) => {
			// 1. Create Account
			const account = await tx.account.create({
				data: { name: vendorName, type: "VENDOR", balance: opening },
			});

			// 2. Create Vendor
			const created = await tx.vendor.create({
				data: {
					vendorName,
					category,
					vendorType: vendorType || null,
					email: email || null,
					phone: phone || null,
					address: address || null,
					openingBalance: opening,
					vendorDate: businessDate,
					status: status === undefined ? true : Boolean(status),
					accountId: account.id,
				},
			});

			// 3. Link Account referenceId
			await tx.account.update({
				where: { id: account.id },
				data: { referenceId: created.id },
			});

			// 4. Opening Balance Ledger Entry
			// DEBIT vendor: we owe them (Debit increases balance, positive = payable)
			// CREDIT vendor: they owe us (Credit increases balance, positive = receivable from vendor)
			if (opening > 0) {
				await tx.ledgerEntry.create({
					data: {
						accountId: account.id,
						entryType: "OPENING_BALANCE",
						debit: isDebit ? 0 : opening,
						credit: isDebit ? opening : 0,
						transactionDate: businessDate,
						remarks: "Opening balance",
					},
				});
			}

			return created;
		});

		res.status(201).json({ success: true, data: vendor });
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to create vendor" });
	}
});

/* ======================= UPDATE VENDOR ======================= */
router.put("/:id", authenticate, async (req, res) => {
	try {
		const { vendorName, category, vendorType, email, phone, address, openingBalance, vendorDate, status } = req.body;

		const updated = await prisma.$transaction(async (tx) => {
			// 1. Fetch Vendor
			const vendor = await tx.vendor.findUnique({
				where: { id: req.params.id },
				include: { account: true },
			});
			if (!vendor) throw new Error("NOT_FOUND");

			// 2. Update Vendor fields
			await tx.vendor.update({
				where: { id: vendor.id },
				data: {
					...(vendorName && { vendorName }),
					...(category && { category }),
					...(vendorType !== undefined && { vendorType: vendorType || null }),
					...(email !== undefined && { email: email || null }),
					...(phone !== undefined && { phone: phone || null }),
					...(address !== undefined && { address: address || null }),
					...(vendorDate && { vendorDate: new Date(vendorDate) }),
					...(status !== undefined && { status: Boolean(status) }),
				},
			});

			// 3. Sync Account Name
			if (vendorName && vendor.accountId) {
				await tx.account.update({
					where: { id: vendor.accountId },
					data: { name: vendorName },
				});
			}

			// 4. Opening Balance / Category Change Logic
			const categoryChanged = category && category !== vendor.category;
			const openingChanged = openingBalance !== undefined && Number(openingBalance) !== vendor.openingBalance;

			if (categoryChanged || openingChanged) {
				const accountId = vendor.accountId;

				// Block if non-opening transactions exist
				const hasOtherTx = await tx.ledgerEntry.findFirst({
					where: { accountId, entryType: { not: "OPENING_BALANCE" } },
				});
				if (hasOtherTx) throw new Error("OPENING_LOCKED");

				const newOpening = openingChanged ? Number(openingBalance) : vendor.openingBalance;
				const newCategory = category || vendor.category;
				const isDebit = newCategory === "DEBIT";

				if (isNaN(newOpening) || newOpening < 0) throw new Error("INVALID_OPENING");

				const txDate = vendorDate ? new Date(vendorDate) : vendor.vendorDate || new Date();
				const oldOpening = vendor.openingBalance || 0;
				const delta = newOpening - oldOpening;

				// Find existing opening entry
				const openingEntry = await tx.ledgerEntry.findFirst({
					where: { accountId, entryType: "OPENING_BALANCE" },
				});

				if (openingEntry) {
					// Update existing entry (handle category flip)
					await tx.ledgerEntry.update({
						where: { id: openingEntry.id },
						data: {
							debit: isDebit ? 0 : newOpening,
							credit: isDebit ? newOpening : 0,
							transactionDate: txDate,
							remarks: categoryChanged ? "Opening balance - category updated" : "Opening balance updated",
						},
					});
				} else if (newOpening > 0) {
					// Create new entry
					await tx.ledgerEntry.create({
						data: {
							accountId,
							entryType: "OPENING_BALANCE",
							debit: isDebit ? 0 : newOpening,
							credit: isDebit ? newOpening : 0,
							transactionDate: txDate,
							remarks: "Opening balance",
						},
					});
				}

				// Update Account balance and Vendor openingBalance
				if (categoryChanged && !openingChanged) {
					// Category changed but amount same: balance stays same, just ledger debit/credit flips
					await tx.account.update({
						where: { id: accountId },
						data: { balance: newOpening },
					});
				} else {
					// Opening changed: adjust balance by delta
					await tx.account.update({
						where: { id: accountId },
						data: { balance: { increment: delta } },
					});
				}

				await tx.vendor.update({
					where: { id: vendor.id },
					data: { openingBalance: newOpening },
				});
			}

			return tx.vendor.findUnique({
				where: { id: vendor.id },
				include: { account: true },
			});
		});

		res.json({ success: true, data: updated });
	} catch (err) {
		if (err.message === "NOT_FOUND") {
			return res.status(404).json({ success: false, error: "Vendor not found" });
		}
		if (err.message === "OPENING_LOCKED") {
			return res.status(409).json({ success: false, error: "Cannot change opening balance or category after transactions exist" });
		}
		if (err.message === "INVALID_OPENING") {
			return res.status(400).json({ success: false, error: "Invalid opening balance" });
		}
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to update vendor" });
	}
});

/* ======================= DELETE VENDOR ======================= */
router.delete("/:id", authenticate, async (req, res) => {
    try {
        // 1. Fetch vendor with entries to check history
        const vendor = await prisma.vendor.findUnique({
            where: { id: req.params.id },
            include: { 
                account: { 
                    include: { entries: true } 
                } 
            },
        });

        if (!vendor) {
            return res.status(404).json({ success: false, error: "Vendor not found" });
        }

        // 2. Determine if there is "real" transaction data
        // We look for any entry that isn't the opening balance
        const hasActiveTransactions = vendor.account?.entries?.some(
            (entry) => entry.entryType !== "OPENING_BALANCE"
        );

        if (hasActiveTransactions) {
            // CONDITION A: Transactions exist -> Just Deactivate (Soft Delete)
            const updated = await prisma.vendor.update({
                where: { id: req.params.id },
                data: { status: false },
            });

            return res.json({ 
                success: true, 
                message: "Vendor has transaction history. They have been deactivated instead of deleted.", 
                data: updated,
                type: "soft-delete"
            });
        } else {
            // CONDITION B: No transactions (only opening balance or empty) -> Hard Delete
            await prisma.$transaction([
                // Remove opening balance entries first
                prisma.ledgerEntry.deleteMany({ 
                    where: { accountId: vendor.accountId } 
                }),
                // Delete vendor
                prisma.vendor.delete({ 
                    where: { id: req.params.id } 
                }),
                // Delete the financial account record
                prisma.account.delete({ 
                    where: { id: vendor.accountId } 
                }),
            ]);

            return res.json({ 
                success: true, 
                message: "Vendor and empty account records permanently deleted.",
                type: "hard-delete"
            });
        }

    } catch (err) {
        console.error("Delete Error:", err);
        res.status(500).json({ success: false, error: "Failed to process vendor removal" });
    }
});

export default router;