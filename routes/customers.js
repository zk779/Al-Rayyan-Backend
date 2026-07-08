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

/* ======================= GET ALL CUSTOMERS ======================= */
router.get("/", authenticate, async (req, res) => {
    try {
        // 1. Destructure 'search' from req.query
        const { search, customerType, isActive, orderBy = "customerDate", orderDir = "desc" } = req.query;

        const customers = await prisma.customer.findMany({
            where: {
                ...(customerType && { customerType: String(customerType) }),
                ...(isActive !== undefined && { isActive: isActive === "true" }),
                // 2. Add partial, case-insensitive search by name
                ...(search && {
                    customerName: {
                        contains: search,
                        mode: "insensitive",
                    },
                }),
            },
            include: { account: { select: { balance: true } } },
            orderBy: { 
                [["customerDate", "createdAt"].includes(orderBy) ? orderBy : "customerDate"]: orderDir === "asc" ? "asc" : "desc" 
            },
        });

        res.json({ success: true, data: customers });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: "Failed to fetch customers" });
    }
});

/* ======================= GET CUSTOMER BY ID ======================= */
router.get("/:id", authenticate, async (req, res) => {
	try {
		const { ledgerOrderDir = "asc" } = req.query;

		const customer = await prisma.customer.findUnique({
			where: { id: req.params.id },
			include: {
				account: {
					include: {
						entries: { orderBy: { transactionDate: ledgerOrderDir === "desc" ? "desc" : "asc" } },
					},
				},
			},
		});

		if (!customer) return res.status(404).json({ success: false, error: "Customer not found" });

		res.json({ success: true, data: customer });
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to fetch customer" });
	}
});

/* ======================= CREATE CUSTOMER ======================= */
router.post("/", authenticate, async (req, res) => {
	try {
		const { customerName, customerType, customerVatId, contactPerson, phone, email, address, openingBalance, isActive, customerDate } = req.body;

		// Validation
		if (!customerName || !customerType || !contactPerson || !phone) {
			return res.status(400).json({ success: false, error: "customerName, customerType, contactPerson, phone are required" });
		}

		const type = String(customerType).toUpperCase();
		if (!["WALK_IN", "CORPORATE" , "TABBY_OR_TAMARA"].includes(type)) {
			return res.status(400).json({ success: false, error: "Invalid customer type" });
		}

		const opening = Number(openingBalance || 0);
		if (opening < 0 || isNaN(opening)) {
			return res.status(400).json({ success: false, error: "Opening balance must be non-negative" });
		}

		// Check duplicates
		const exists = await prisma.customer.findFirst({
			where: { OR: [{ phone: String(phone) }, { customerName: String(customerName) }] },
		});
		if (exists) {
			return res.status(400).json({ success: false, error: "Customer already exists (same phone or name)" });
		}

		const businessDate = customerDate ? new Date(customerDate) : new Date();

		const customer = await prisma.$transaction(async (tx) => {
			// 1. Create Account
			const account = await tx.account.create({
				data: { name: customerName, type: "CUSTOMER", balance: opening },
			});

			// 2. Create Customer
			const created = await tx.customer.create({
				data: {
					customerName,
					customerType: type,
					customerVatId,
					contactPerson,
					phone,
					email: email || null,
					address: address || null,
					openingBalance: opening,
					customerDate: businessDate,
					isActive: isActive === undefined ? true : Boolean(isActive),
					accountId: account.id,
				},
			});

			// 3. Link Account referenceId
			await tx.account.update({
				where: { id: account.id },
				data: { referenceId: created.id },
			});

			// 4. Opening Balance Ledger Entry (if > 0)
			if (opening > 0) {
				await tx.ledgerEntry.create({
					data: {
						accountId: account.id,
						entryType: "OPENING_BALANCE",
						debit: opening, // Customer owes us (Debit = Receivable)
						credit: 0,
						transactionDate: businessDate,
						remarks: "Opening balance",
					},
				});
			}

			return created;
		});

		res.status(201).json({ success: true, data: customer });
	} catch (err) {
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to create customer" });
	}
});

/* ======================= UPDATE CUSTOMER ======================= */
router.put("/:id", authenticate, async (req, res) => {
	try {
		const { customerName, customerType, customerVatId, contactPerson, phone, email, address, openingBalance, isActive, customerDate } = req.body;

		const updated = await prisma.$transaction(async (tx) => {
			// 1. Fetch Customer
			const customer = await tx.customer.findUnique({
				where: { id: req.params.id },
				include: { account: true },
			});
			if (!customer) throw new Error("NOT_FOUND");

			// 2. Update Customer fields
			await tx.customer.update({
				where: { id: customer.id },
				data: {
					...(customerName && { customerName }),
					...(customerType && { customerType: String(customerType).toUpperCase() }),
					...(customerVatId !== undefined && { customerVatId }),
					...(contactPerson && { contactPerson }),
					...(phone && { phone }),
					...(email !== undefined && { email: email || null }),
					...(address !== undefined && { address: address || null }),
					...(customerDate && { customerDate: new Date(customerDate) }),
					...(isActive !== undefined && { isActive: Boolean(isActive) }),
				},
			});

			// 3. Sync Account Name
			if (customerName && customer.accountId) {
				await tx.account.update({
					where: { id: customer.accountId },
					data: { name: customerName },
				});
			}

			// 4. Opening Balance Update Logic
			if (openingBalance !== undefined) {
				const newOpening = Number(openingBalance || 0);
				const oldOpening = Number(customer.openingBalance || 0);

				if (isNaN(newOpening) || newOpening < 0) throw new Error("INVALID_OPENING");

				if (newOpening !== oldOpening) {
					const accountId = customer.accountId;
					const txDate = customerDate ? new Date(customerDate) : customer.customerDate || new Date();

					// Block if non-opening transactions exist
					const hasOtherTx = await tx.ledgerEntry.findFirst({
						where: { accountId, entryType: { not: "OPENING_BALANCE" } },
					});
					if (hasOtherTx) throw new Error("OPENING_LOCKED");

					// Find existing opening entry
					const openingEntry = await tx.ledgerEntry.findFirst({
						where: { accountId, entryType: "OPENING_BALANCE" },
					});

					const delta = newOpening - oldOpening;

					if (openingEntry) {
						// Update existing entry
						await tx.ledgerEntry.update({
							where: { id: openingEntry.id },
							data: {
								debit: newOpening,
								credit: 0,
								transactionDate: txDate,
								remarks: "Opening balance updated",
							},
						});
					} else if (newOpening > 0) {
						// Create new entry
						await tx.ledgerEntry.create({
							data: {
								accountId,
								entryType: "OPENING_BALANCE",
								debit: newOpening,
								credit: 0,
								transactionDate: txDate,
								remarks: "Opening balance",
							},
						});
					}

					// Update Account balance and Customer openingBalance
					await tx.account.update({
						where: { id: accountId },
						data: { balance: { increment: delta } },
					});

					await tx.customer.update({
						where: { id: customer.id },
						data: { openingBalance: newOpening },
					});
				}
			}

			return tx.customer.findUnique({
				where: { id: customer.id },
				include: { account: true },
			});
		});

		res.json({ success: true, data: updated });
	} catch (err) {
		if (err.message === "NOT_FOUND") {
			return res.status(404).json({ success: false, error: "Customer not found" });
		}
		if (err.message === "OPENING_LOCKED") {
			return res.status(409).json({ success: false, error: "Cannot change opening balance after transactions exist" });
		}
		if (err.message === "INVALID_OPENING") {
			return res.status(400).json({ success: false, error: "Invalid opening balance" });
		}
		console.error(err);
		res.status(500).json({ success: false, error: "Failed to update customer" });
	}
});

/* ======================= DELETE CUSTOMER ======================= */
router.delete("/:id", authenticate, async (req, res) => {
    try {
        // 1. Fetch customer with account entries to check history
        const customer = await prisma.customer.findUnique({
            where: { id: req.params.id },
            include: { 
                account: { 
                    include: { entries: true } 
                } 
            },
        });

        if (!customer) {
            return res.status(404).json({ success: false, error: "Customer not found" });
        }

        // 2. Check for "real" transaction history
        // Returns true if there are entries other than the opening balance
        const hasActiveTransactions = customer.account?.entries?.some(
            (entry) => entry.entryType !== "OPENING_BALANCE"
        );

        if (hasActiveTransactions) {
            // PATH A: Transactions exist -> Deactivate (Soft Delete)
            // Note: Using 'isActive' as per your original code
            const updated = await prisma.customer.update({
                where: { id: req.params.id },
                data: { isActive: false },
            });

            return res.json({ 
                success: true, 
                message: "Customer has transaction history. They have been deactivated to preserve ledger integrity.", 
                data: updated,
                type: "soft-delete"
            });
        } else {
            // PATH B: No transactions -> Hard Delete (Complete Cleanup)
            await prisma.$transaction([
                // 1. Delete the opening balance ledger entries
                prisma.ledgerEntry.deleteMany({ 
                    where: { accountId: customer.accountId } 
                }),
                // 2. Delete the customer record
                prisma.customer.delete({ 
                    where: { id: req.params.id } 
                }),
                // 3. Delete the financial account record
                prisma.account.delete({ 
                    where: { id: customer.accountId } 
                }),
            ]);

            return res.json({ 
                success: true, 
                message: "Customer and unused account records permanently deleted.",
                type: "hard-delete"
            });
        }

    } catch (err) {
        console.error("Customer Delete Error:", err);
        res.status(500).json({ success: false, error: "Failed to process customer removal" });
    }
});

export default router;