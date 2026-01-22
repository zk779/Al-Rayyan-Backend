import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

const router = express.Router();
const prisma = new PrismaClient();

/* ======================= AUTH ======================= */
async function authenticate(req, res, next) {
	const authHeader = req.headers.authorization;
	if (!authHeader)
		return res.status(401).json({ error: "Missing Authorization header" });

	try {
		const token = authHeader.split(" ")[1];
		const decoded = jwt.verify(token, process.env.JWT_SECRET);

		const user = await prisma.user.findUnique({
			where: { id: decoded.id },
		});

		if (!user || !user.isActive)
			return res.status(401).json({ error: "User inactive or removed" });

		req.user = decoded;
		next();
	} catch {
		res.status(401).json({ error: "Invalid or expired token" });
	}
}

/* ======================= GET ALL VENDORS ======================= */
router.get("/", authenticate, async (req, res) => {
	try {
		const {
			category,
			status,
			orderBy = "vendorDate",
			orderDir = "desc",
		} = req.query;

		const validOrderBy = ["createdAt", "vendorDate"];
		const validOrderDir = ["asc", "desc"];

		const finalOrderBy = validOrderBy.includes(orderBy)
			? orderBy
			: "vendorDate";

		const finalOrderDir = validOrderDir.includes(orderDir) ? orderDir : "desc";

		const vendors = await prisma.vendor.findMany({
			where: {
				...(category ? { category } : {}),
				...(status !== undefined ? { status: status === "true" } : {}),
			},
			include: {
				account: { select: { balance: true } },
			},
			orderBy: {
				[finalOrderBy]: finalOrderDir,
			},
		});

		res.json({ success: true, data: vendors });
	} catch (err) {
		console.error(err);
		res.status(500).json({
			success: false,
			error: "Failed to fetch vendors",
		});
	}
});

/* ======================= GET VENDOR BY ID ======================= */
router.get("/:id", authenticate, async (req, res) => {
	try {
		const { ledgerOrderBy = "createdAt", ledgerOrderDir = "asc" } = req.query;

		const validLedgerOrderBy = ["createdAt"];
		const validLedgerOrderDir = ["asc", "desc"];

		const finalLedgerOrderBy = validLedgerOrderBy.includes(ledgerOrderBy)
			? ledgerOrderBy
			: "createdAt";

		const finalLedgerOrderDir = validLedgerOrderDir.includes(ledgerOrderDir)
			? ledgerOrderDir
			: "asc";

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

		if (!vendor) {
			return res.status(404).json({
				success: false,
				error: "Vendor not found",
			});
		}

		res.json({ success: true, data: vendor });
	} catch (err) {
		console.error(err);
		res.status(500).json({
			success: false,
			error: "Failed to fetch vendor",
		});
	}
});

/* ======================= CREATE VENDOR ======================= */
router.post("/", authenticate, async (req, res) => {
	try {
		const {
			vendorName,
			category,
			vendorType,
			email,
			phone,
			address,
			openingBalance,
			vendorDate,
			status,
		} = req.body;

		if (!vendorName || !category)
			return res.status(400).json({
				success: false,
				error: "Vendor Name and Category are required",
			});

		if (!["CREDIT", "DEBIT"].includes(category))
			return res.status(400).json({
				success: false,
				error: "Invalid vendor category",
			});

		const exists = await prisma.vendor.findFirst({ where: { vendorName } });
		if (exists) {
			return res
				.status(400)
				.json({ success: false, error: "Vendor already exists" });
		}

		const opening = Number(openingBalance || 0);
		if (opening < 0 || Number.isNaN(opening))
			return res.status(400).json({
				success: false,
				error: "Invalid opening balance",
			});

		const businessDate = vendorDate ? new Date(vendorDate) : new Date();

		const vendor = await prisma.$transaction(async (tx) => {
			const account = await tx.account.create({
				data: {
					name: vendorName,
					type: "VENDOR",
					balance: opening,
				},
			});

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

			await tx.account.update({
				where: { id: account.id },
				data: { referenceId: created.id },
			});

			if (opening > 0) {
				const isDebitVendor = category === "DEBIT";

				await tx.ledgerEntry.create({
					data: {
						accountId: account.id,
						entryType: "OPENING_BALANCE",
						debit: isDebitVendor ? opening : 0,
						credit: isDebitVendor ? 0 : opening,
						balanceAfter: opening,
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
		res.status(500).json({
			success: false,
			error: "Failed to create vendor",
		});
	}
});

/* ======================= UPDATE VENDOR ======================= */
/* ======================= UPDATE VENDOR ======================= */

router.put("/:id", authenticate, async (req, res) => {
	try {
		const {
			vendorName,
			category,
			vendorType,
			email,
			phone,
			address,
			openingBalance,
			vendorDate,
			status,
		} = req.body;

		const updatedVendor = await prisma.$transaction(async (tx) => {
			/* ======================================================
				1️⃣ Fetch Vendor
			====================================================== */
			const vendor = await tx.vendor.findUnique({
				where: { id: req.params.id },
			});

			if (!vendor) throw new Error("NOT_FOUND");

			/* ======================================================
				2️⃣ Update Vendor Fields (SAFE PATCH)
			====================================================== */
			await tx.vendor.update({
				where: { id: vendor.id },
				data: {
					...(vendorName !== undefined ? { vendorName } : {}),
					...(category !== undefined ? { category } : {}),
					...(vendorType !== undefined ? { vendorType } : {}),
					...(email !== undefined ? { email: email || null } : {}),
					...(phone !== undefined ? { phone } : {}),
					...(address !== undefined ? { address: address || null } : {}),
					...(vendorDate !== undefined
						? { vendorDate: new Date(vendorDate) }
						: {}),
					...(status !== undefined ? { status: Boolean(status) } : {}),
				},
			});

			/* ======================================================
				3️⃣ OPENING BALANCE LOGIC (ONLY IF CHANGED)
			====================================================== */
			if (openingBalance !== undefined) {
				const incomingOpening = Number(openingBalance || 0);
				const currentOpening = Number(vendor.openingBalance || 0);

				if (Number.isNaN(incomingOpening) || incomingOpening < 0) {
					throw new Error("INVALID_OPENING");
				}

				const isOpeningChanged = incomingOpening !== currentOpening;

				// 🔹 If opening balance not changed → SKIP EVERYTHING
				if (!isOpeningChanged) {
					return tx.vendor.findUnique({ where: { id: vendor.id } });
				}

				const businessDate = vendorDate
					? new Date(vendorDate)
					: vendor.vendorDate || new Date();

				const isDebitVendor =
					(category ?? vendor.category) === "DEBIT";

				let accountId = vendor.accountId;

				/* ======================================================
					3A️⃣ Create Account if Missing
				====================================================== */
				if (!accountId) {
					const account = await tx.account.create({
						data: {
							name: vendorName ?? vendor.vendorName,
							type: "VENDOR",
							balance: incomingOpening,
						},
					});

					await tx.vendor.update({
						where: { id: vendor.id },
						data: {
							accountId: account.id,
							openingBalance: incomingOpening,
						},
					});

					if (incomingOpening > 0) {
						await tx.ledgerEntry.create({
							data: {
								accountId: account.id,
								entryType: "OPENING_BALANCE",
								debit: isDebitVendor ? incomingOpening : 0,
								credit: isDebitVendor ? 0 : incomingOpening,
								balanceAfter: incomingOpening,
								transactionDate: businessDate,
								remarks: "Opening balance",
							},
						});
					}

					return tx.vendor.findUnique({ where: { id: vendor.id } });
				}

				/* ======================================================
					3B️⃣ Block if Transactions Exist
				====================================================== */
				const hasTransactions = await tx.ledgerEntry.findFirst({
					where: {
						accountId,
						entryType: { not: "OPENING_BALANCE" },
					},
				});

				if (hasTransactions) {
					throw new Error("OPENING_LOCKED");
				}

				/* ======================================================
					3C️⃣ Update or Create Opening Ledger Entry
				====================================================== */
				const openingEntry = await tx.ledgerEntry.findFirst({
					where: {
						accountId,
						entryType: "OPENING_BALANCE",
					},
					orderBy: { createdAt: "asc" },
				});

				if (openingEntry) {
					await tx.ledgerEntry.update({
						where: { id: openingEntry.id },
						data: {
							debit: isDebitVendor ? incomingOpening : 0,
							credit: isDebitVendor ? 0 : incomingOpening,
							balanceAfter: incomingOpening,
							transactionDate: businessDate,
							remarks: "Opening balance updated",
						},
					});
				} else if (incomingOpening > 0) {
					await tx.ledgerEntry.create({
						data: {
							accountId,
							entryType: "OPENING_BALANCE",
							debit: isDebitVendor ? incomingOpening : 0,
							credit: isDebitVendor ? 0 : incomingOpening,
							balanceAfter: incomingOpening,
							transactionDate: businessDate,
							remarks: "Opening balance",
						},
					});
				}

				/* ======================================================
					3D️⃣ Sync Account & Vendor
				====================================================== */
				await tx.account.update({
					where: { id: accountId },
					data: { balance: incomingOpening },
				});

				await tx.vendor.update({
					where: { id: vendor.id },
					data: { openingBalance: incomingOpening },
				});
			}

			/* ======================================================
				4️⃣ Return Updated Vendor
			====================================================== */
			return tx.vendor.findUnique({
				where: { id: vendor.id },
				include: { account: true },
			});
		});

		res.json({
			success: true,
			data: updatedVendor,
		});
	} catch (err) {
		if (err.message === "NOT_FOUND") {
			return res.status(404).json({
				success: false,
				error: "Vendor not found",
			});
		}

		if (err.message === "OPENING_LOCKED") {
			return res.status(409).json({
				success: false,
				error:
					"Opening balance cannot be changed once transactions exist",
			});
		}

		if (err.message === "INVALID_OPENING") {
			return res.status(400).json({
				success: false,
				error: "Invalid opening balance",
			});
		}

		console.error(err);
		res.status(500).json({
			success: false,
			error: "Failed to update vendor",
		});
	}
});


/* ======================= DELETE ======================= */
router.delete("/:id", authenticate, async (req, res) => {
	try {
		await prisma.vendor.delete({ where: { id: req.params.id } });
		res.json({ success: true, message: "Vendor deleted successfully" });
	} catch (err) {
		console.error(err);
		res.status(500).json({
			success: false,
			error: "Failed to delete vendor",
		});
	}
});

export default router;
