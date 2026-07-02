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

/* ======================= GET ALL BANKS ======================= */
router.get("/", authenticate, async (req, res) => {
	try {
		const { isActive, orderBy = "bankDate", orderDir = "desc" } = req.query;

		const banks = await prisma.bank.findMany({
			where: {
				...(isActive !== undefined && { isActive: isActive === "true" }),
			},
			include: { account: { select: { balance: true } } },
			orderBy: {
				[["createdAt", "bankDate"].includes(orderBy) ? orderBy : "bankDate"]:
					orderDir === "asc" ? "asc" : "desc",
			},
		});

		res.json({ success: true, data: banks });
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to fetch banks" });
	}
});

/* ======================= GET BANK BY ID ======================= */
router.get("/:id", authenticate, async (req, res) => {
	try {
		const bank = await prisma.bank.findUnique({
			where: { id: req.params.id },
			include: {
				account: {
					include: {
						entries: { orderBy: { transactionDate: "asc" } },
					},
				},
			},
		});

		if (!bank) return res.status(404).json({ success: false, error: "Bank not found" });

		res.json({ success: true, data: bank });
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to fetch bank" });
	}
});

/* ======================= CREATE BANK ======================= */
router.post("/", authenticate, async (req, res) => {
	try {
		const { bankName, accountNumber, branchName, swiftCode, openingBalance, bankDate, isActive } = req.body;

		if (!bankName || !accountNumber) {
			return res.status(400).json({ success: false, error: "bankName and accountNumber are required" });
		}

		const exists = await prisma.bank.findUnique({ where: { accountNumber } });
		if (exists) {
			return res.status(400).json({ success: false, error: "A bank with this account number already exists" });
		}

		const opening = Number(openingBalance || 0);
		if (isNaN(opening) || opening < 0) {
			return res.status(400).json({ success: false, error: "Invalid opening balance" });
		}

		const businessDate = bankDate ? new Date(bankDate) : new Date();

		const bank = await prisma.$transaction(async (tx) => {
			// 1. Create Account
			const account = await tx.account.create({
				data: { name: bankName, type: "BANK", balance: opening },
			});

			// 2. Create Bank
			const created = await tx.bank.create({
				data: {
					bankName,
					accountNumber,
					branchName: branchName || null,
					swiftCode:  swiftCode  || null,
					openingBalance: opening,
					bankDate: businessDate,
					isActive: isActive === undefined ? true : Boolean(isActive),
					accountId: account.id,
				},
			});

			// 3. Link Account referenceId back to the bank
			await tx.account.update({
				where: { id: account.id },
				data: { referenceId: created.id },
			});

			// 4. Opening Balance Ledger Entry
			// Bank accounts are assets — debit increases balance
			if (opening > 0) {
				await tx.ledgerEntry.create({
					data: {
						accountId: account.id,
						entryType: "OPENING_BALANCE",
						debit: 0,
						credit: opening,
						transactionDate: businessDate,
						remarks: "Opening balance",
					},
				});
			}

			return created;
		});

		res.status(201).json({ success: true, data: bank });
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to create bank" });
	}
});

/* ======================= UPDATE BANK ======================= */
router.put("/:id", authenticate, async (req, res) => {
	try {
		const { bankName, accountNumber, branchName, swiftCode, openingBalance, bankDate, isActive } = req.body;

		const updated = await prisma.$transaction(async (tx) => {
			// 1. Fetch Bank
			const bank = await tx.bank.findUnique({
				where: { id: req.params.id },
				include: { account: true },
			});
			if (!bank) throw new Error("NOT_FOUND");

			// 2. Account number uniqueness check
			if (accountNumber && accountNumber !== bank.accountNumber) {
				const conflict = await tx.bank.findUnique({ where: { accountNumber } });
				if (conflict) throw new Error("DUPLICATE_ACCOUNT_NUMBER");
			}

			// 3. Update Bank fields
			await tx.bank.update({
				where: { id: bank.id },
				data: {
					...(bankName        && { bankName }),
					...(accountNumber   && { accountNumber }),
					...(branchName !== undefined && { branchName: branchName || null }),
					...(swiftCode  !== undefined && { swiftCode:  swiftCode  || null }),
					...(bankDate        && { bankDate: new Date(bankDate) }),
					...(isActive !== undefined && { isActive: Boolean(isActive) }),
				},
			});

			// 4. Sync Account name
			if (bankName && bank.accountId) {
				await tx.account.update({
					where: { id: bank.accountId },
					data: { name: bankName },
				});
			}

			// 5. Opening Balance Change Logic
			const openingChanged =
				openingBalance !== undefined && Number(openingBalance) !== bank.openingBalance;

			if (openingChanged) {
				// Block if non-opening transactions exist
				const hasOtherTx = await tx.ledgerEntry.findFirst({
					where: { accountId: bank.accountId, entryType: { not: "OPENING_BALANCE" } },
				});
				if (hasOtherTx) throw new Error("OPENING_LOCKED");

				const newOpening = Number(openingBalance);
				if (isNaN(newOpening) || newOpening < 0) throw new Error("INVALID_OPENING");

				const delta    = newOpening - (bank.openingBalance || 0);
				const txDate   = bankDate ? new Date(bankDate) : bank.bankDate || new Date();

				const existingEntry = await tx.ledgerEntry.findFirst({
					where: { accountId: bank.accountId, entryType: "OPENING_BALANCE" },
				});

				if (existingEntry) {
					await tx.ledgerEntry.update({
						where: { id: existingEntry.id },
						data: {
							debit: 0,
							credit: newOpening,
							transactionDate: txDate,
							remarks: "Opening balance updated",
						},
					});
				} else if (newOpening > 0) {
					await tx.ledgerEntry.create({
						data: {
							accountId: bank.accountId,
							entryType: "OPENING_BALANCE",
							debit: 0,
							credit: newOpening,
							transactionDate: txDate,
							remarks: "Opening balance",
						},
					});
				}

				// Adjust account balance by the delta
				await tx.account.update({
					where: { id: bank.accountId },
					data: { balance: { increment: delta } },
				});

				await tx.bank.update({
					where: { id: bank.id },
					data: { openingBalance: newOpening },
				});
			}

			return tx.bank.findUnique({
				where: { id: bank.id },
				include: { account: true },
			});
		});

		res.json({ success: true, data: updated });
	} catch (err) {
		if (err.message === "NOT_FOUND")
			return res.status(404).json({ success: false, error: "Bank not found" });
		if (err.message === "DUPLICATE_ACCOUNT_NUMBER")
			return res.status(400).json({ success: false, error: "Account number already in use" });
		if (err.message === "OPENING_LOCKED")
			return res.status(409).json({ success: false, error: "Cannot change opening balance after transactions exist" });
		if (err.message === "INVALID_OPENING")
			return res.status(400).json({ success: false, error: "Invalid opening balance" });
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to update bank" });
	}
});
/* ======================= DELETE BANK ======================= */
router.delete("/:id", authenticate, async (req, res) => {
	try {
		const bank = await prisma.bank.findUnique({
			where: { id: req.params.id },
			include: { account: { include: { entries: true } } },
		});

		if (!bank) return res.status(404).json({ success: false, error: "Bank not found" });

		const hasActiveTransactions = bank.account?.entries?.some(
			(e) => e.entryType !== "OPENING_BALANCE"
		);

		if (hasActiveTransactions) {
			// Soft delete — bank has real transaction history
			const updated = await prisma.bank.update({
				where: { id: req.params.id },
				data: { isActive: false },
			});

			return res.json({
				success: true,
				message: "Bank has transaction history and has been deactivated instead of deleted.",
				data: updated,
				type: "soft-delete",
			});
		}

		// Hard delete — no real transactions, safe to wipe
		await prisma.$transaction([
			prisma.ledgerEntry.deleteMany({ where: { accountId: bank.accountId } }),
			prisma.bank.delete({ where: { id: req.params.id } }),
			prisma.account.delete({ where: { id: bank.accountId } }),
		]);

		return res.json({
			success: true,
			message: "Bank and its empty account records permanently deleted.",
			type: "hard-delete",
		});
	} catch (err) {
		console.error("Delete Error:", err);
		res.status(500).json({ success: false, error: "Failed to process bank removal" });
	}
});

export default router;