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

/* ======================= GET ALL CUSTOMERS ======================= */
router.get("/", authenticate, async (req, res) => {
	try {
		const {
			customerType,
			isActive,
			orderBy = "customerDate",
			orderDir = "desc",
		} = req.query;

		const validOrderBy = ["customerDate", "createdAt"];
		const validOrderDir = ["asc", "desc"];

		const finalOrderBy = validOrderBy.includes(orderBy)
			? orderBy
			: "customerDate";

		const finalOrderDir = validOrderDir.includes(orderDir) ? orderDir : "desc";

		const customers = await prisma.customer.findMany({
			where: {
				...(customerType ? { customerType: String(customerType) } : {}),
				...(isActive !== undefined ? { isActive: isActive === "true" } : {}),
			},
			include: {
				account: { select: { balance: true } },
			},
			orderBy: {
				[finalOrderBy]: finalOrderDir,
			},
		});

		res.json({ success: true, data: customers });
	} catch (err) {
		console.error(err);
		res.status(500).json({
			success: false,
			error: "Failed to fetch customers",
		});
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
						entries: {
							orderBy: {
								transactionDate: ledgerOrderDir === "desc" ? "desc" : "asc",
							},
						},
					},
				},
			},
		});

		if (!customer) {
			return res.status(404).json({
				success: false,
				error: "Customer not found",
			});
		}

		res.json({ success: true, data: customer });
	} catch (err) {
		console.error(err);
		res.status(500).json({
			success: false,
			error: "Failed to fetch customer",
		});
	}
});

/* ======================= CREATE CUSTOMER ======================= */
router.post("/", authenticate, async (req, res) => {
	try {
		const {
			customerName,
			customerType,
			customerVatId,
			contactPerson,
			phone,
			email,
			address,
			openingBalance,
			isActive,
			customerDate,
		} = req.body;

		if (!customerName || !customerType || !contactPerson || !phone) {
			return res.status(400).json({
				success: false,
				error: "customerName, customerType, contactPerson, phone are required",
			});
		}

		const type = String(customerType).toUpperCase();
		if (!["WALK_IN", "CORPORATE"].includes(type)) {
			return res.status(400).json({
				success: false,
				error: "Invalid customer type",
			});
		}

		const opening = Number(openingBalance || 0);
		if (opening < 0 || Number.isNaN(opening)) {
			return res.status(400).json({
				success: false,
				error: "Opening balance must be a valid non-negative number",
			});
		}

		const exists = await prisma.customer.findFirst({
			where: {
				OR: [{ phone: String(phone) }, { customerName: String(customerName) }],
			},
		});

		if (exists) {
			return res.status(400).json({
				success: false,
				error: "Customer already exists (same phone or name)",
			});
		}

		const businessDate = customerDate ? new Date(customerDate) : new Date();

		const customer = await prisma.$transaction(async (tx) => {
			/* 1️⃣ Create Account */
			const account = await tx.account.create({
				data: {
					name: customerName,
					type: "CUSTOMER",
					balance: opening,
				},
			});

			/* 2️⃣ Create Customer */
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

			/* 3️⃣ Link Account */
			await tx.account.update({
				where: { id: account.id },
				data: {
					name: customerName,
					referenceId: created.id,
				},
			});

			/* 4️⃣ Opening Balance Ledger Entry */
			if (opening > 0) {
				await tx.ledgerEntry.create({
					data: {
						accountId: account.id,
						entryType: "OPENING_BALANCE",
						debit: opening,
						credit: 0,
						balanceAfter: opening,
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
		res.status(500).json({
			success: false,
			error: "Failed to create customer",
		});
	}
});

/* ======================= UPDATE CUSTOMER ======================= */
router.put("/:id", authenticate, async (req, res) => {
    try {
        const {
            customerName,
            customerType,
            customerVatId,
            contactPerson,
            phone,
            email,
            address,
            openingBalance,
            isActive,
            customerDate,
        } = req.body;

        const updatedCustomer = await prisma.$transaction(async (tx) => {
            /* 1️⃣ Fetch Customer + Account */
            const customer = await tx.customer.findUnique({
                where: { id: req.params.id },
                include: { account: true },
            });

            if (!customer) throw new Error("NOT_FOUND");

            /* 2️⃣ Update Customer Basic Info */
            await tx.customer.update({
                where: { id: customer.id },
                data: {
                    ...(customerName !== undefined ? { customerName } : {}),
                    ...(customerType !== undefined ? { customerType: String(customerType).toUpperCase() } : {}),
                    ...(customerVatId !== undefined ? { customerVatId } : {}),
                    ...(contactPerson !== undefined ? { contactPerson } : {}),
                    ...(phone !== undefined ? { phone } : {}),
                    ...(email !== undefined ? { email: email || null } : {}),
                    ...(address !== undefined ? { address: address || null } : {}),
                    ...(customerDate !== undefined ? { customerDate: new Date(customerDate) } : {}),
                    ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
                },
            });

            /* 2.5️⃣ Sync Account Name if changed */
            if (customerName !== undefined && customer.accountId && customerName !== customer.customerName) {
                await tx.account.update({
                    where: { id: customer.accountId },
                    data: { name: customerName },
                });
            }

            /* 3️⃣ OPENING BALANCE LOGIC (SYNC FIX) */
            if (openingBalance !== undefined) {
                const incomingOpening = Number(openingBalance || 0);
                const currentOpening = Number(customer.openingBalance || 0);

                if (isNaN(incomingOpening) || incomingOpening < 0) {
                    throw new Error("INVALID_OPENING");
                }

                // If balance changed OR ledger is missing
                if (incomingOpening !== currentOpening) {
                    const transactionDate = customerDate ? new Date(customerDate) : (customer.customerDate || new Date());
                    let accountId = customer.accountId;

                    /* 3A️⃣ Create Account if Missing (Safety) */
                    if (!accountId) {
                        const newAcc = await tx.account.create({
                            data: {
                                name: customerName ?? customer.customerName,
                                type: "CUSTOMER", // Ensure your account model supports this type
                                balance: incomingOpening,
                            },
                        });
                        accountId = newAcc.id;
                        await tx.customer.update({
                            where: { id: customer.id },
                            data: { accountId: accountId }
                        });
                    }

                    /* 3B️⃣ Block if Transactions Exist */
                    const hasTransactions = await tx.ledgerEntry.findFirst({
                        where: {
                            accountId,
                            entryType: { not: "OPENING_BALANCE" },
                        },
                    });

                    if (hasTransactions) throw new Error("OPENING_LOCKED");

                    /* 3C️⃣ Update or Create Opening Ledger Entry */
                    const openingEntry = await tx.ledgerEntry.findFirst({
                        where: { accountId, entryType: "OPENING_BALANCE" },
                    });

                    if (openingEntry) {
                        await tx.ledgerEntry.update({
                            where: { id: openingEntry.id },
                            data: {
                                debit: incomingOpening, // Customers are usually Debit (Receivables)
                                credit: 0,
                                balanceAfter: incomingOpening,
                                transactionDate: transactionDate,
                                remarks: "Opening balance updated",
                            },
                        });
                    } else {
                        // FORCE CREATE if missing
                        await tx.ledgerEntry.create({
                            data: {
                                accountId,
                                entryType: "OPENING_BALANCE",
                                debit: incomingOpening,
                                credit: 0,
                                balanceAfter: incomingOpening,
                                transactionDate: transactionDate,
                                remarks: "Opening balance initialized",
                            },
                        });
                    }

                    /* 3D️⃣ Sync Totals */
                    await tx.account.update({
                        where: { id: accountId },
                        data: { balance: incomingOpening },
                    });

                    await tx.customer.update({
                        where: { id: customer.id },
                        data: { openingBalance: incomingOpening },
                    });
                }
            }

            /* 4️⃣ Final Return */
            return tx.customer.findUnique({
                where: { id: customer.id },
                include: { account: true },
            });
        });

        res.json({ success: true, data: updatedCustomer });
    } catch (err) {
        const errorMap = {
            "NOT_FOUND": { status: 404, msg: "Customer not found" },
            "OPENING_LOCKED": { status: 409, msg: "Opening balance cannot be changed once transactions exist" },
            "INVALID_OPENING": { status: 400, msg: "Invalid opening balance" }
        };

        const mappedError = errorMap[err.message];
        if (mappedError) {
            return res.status(mappedError.status).json({ success: false, error: mappedError.msg });
        }

        console.error(err);
        res.status(500).json({ success: false, error: "Failed to update customer" });
    }
});



/* ======================= DELETE ======================= */
router.delete("/:id", authenticate, async (req, res) => {
	try {
		const hard = req.query.hard === "true";

		if (hard) {
			await prisma.customer.delete({ where: { id: req.params.id } });
			return res.json({
				success: true,
				message: "Customer deleted",
			});
		}

		const customer = await prisma.customer.update({
			where: { id: req.params.id },
			data: { isActive: false },
		});

		res.json({
			success: true,
			message: "Customer deactivated",
			data: customer,
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({
			success: false,
			error: "Failed to delete customer",
		});
	}
});

export default router;
