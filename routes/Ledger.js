import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

const router = express.Router();
const prisma = new PrismaClient();

/* =========================== 🔐 AUTH =========================== */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res
      .status(401)
      .json({ success: false, error: "Missing Authorization header" });

  try {
    const token = authHeader.split(" ")[1];
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res
      .status(401)
      .json({ success: false, error: "Invalid or expired token" });
  }
}

/* ===============================================================
   ✅ SINGLE LEDGER GET API (BUSINESS DATE AWARE)
   =============================================================== */
/**
 * GET /api/ledger
 *
 * Filters (all optional):
 * - accountType=VENDOR
 * - accountTypes=VENDOR,CUSTOMER,EXPENSE
 * - entryType=SALE
 * - entryTypes=SALE,PAYMENT
 * - vendorId=...
 * - customerId=...
 * - from=2025-01-01
 * - to=2025-01-31
 * - page=1
 * - limit=50
 */
router.get("/", authenticate, async (req, res) => {
  try {
    const {
      accountType,
      accountTypes,
      entryType,
      entryTypes,
      vendorId,
      customerId,
      from,
      to,
      page = 1,
      limit = 50,
    } = req.query;

    const take = Math.min(100, Math.max(1, Number(limit)));
    const skip = (Number(page) - 1) * take;

    /* ---------- Account Type Filter ---------- */
    let accountTypeFilter;
    if (accountTypes) {
      accountTypeFilter = accountTypes.split(",");
    } else if (accountType) {
      accountTypeFilter = [accountType];
    }

    /* ---------- Entry Type Filter ---------- */
    let entryTypeFilter;
    if (entryTypes) {
      entryTypeFilter = entryTypes.split(",");
    } else if (entryType) {
      entryTypeFilter = [entryType];
    }

    /* ---------- Reference Filter ---------- */
    let referenceId;
    if (vendorId) referenceId = vendorId;
    if (customerId) referenceId = customerId;

    /* ---------- WHERE CLAUSE ---------- */
    const where = {
      ...(entryTypeFilter && {
        entryType: { in: entryTypeFilter },
      }),
      ...(from || to
        ? {
            transactionDate: {
              ...(from && { gte: new Date(from) }),
              ...(to && { lte: new Date(to) }),
            },
          }
        : {}),
      account: {
        ...(accountTypeFilter && {
          type: { in: accountTypeFilter },
        }),
        ...(referenceId && {
          referenceId,
        }),
      },
    };

    const [entries, total] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where,
        include: {
          account: {
            select: {
              id: true,
              name: true,
              type: true,
              referenceId: true,
              balance: true,
            },
          },
        },
        orderBy: { transactionDate: "desc" }, // ✅ BUSINESS DATE
        skip,
        take,
      }),
      prisma.ledgerEntry.count({ where }),
    ]);

    res.json({
      success: true,
      data: entries,
      meta: {
        page: Number(page),
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch ledger entries",
    });
  }
});

export default router;
