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

/* ----------------------- Helpers ----------------------- */
function pad(num, size = 4) {
  return String(num).padStart(size, "0");
}
function buildKey(date = new Date()) {
  const yy = String(date.getFullYear()).slice(-2);
  return `INV-ALR${yy}`; // INV-ALR26
}

/* ----------------------- ✅ PREVIEW (LAST ISSUED) ----------------------- */
/**
 * GET /api/invoice/preview?saleDate=2026-02-06
 * Returns last issued invoice number (no increment, no +1)
 * If none exists yet, returns INV-ALRxx-0000
 */
router.get("/preview", authenticate, async (req, res) => {
  try {
    const { saleDate } = req.query;
    const date = saleDate ? new Date(saleDate) : new Date();

    if (saleDate && Number.isNaN(date.getTime())) {
      return res.status(400).json({ success: false, error: "Invalid saleDate" });
    }

    const key = buildKey(date);

    const counter = await prisma.invoiceCounter.findUnique({
      where: { key },
      select: { currentNumber: true },
    });

    const lastNumber = counter?.currentNumber || 0;
    const invoiceNo = `${key}-${pad(lastNumber, 4)}`;

    return res.json({
      success: true,
      invoiceNo,
      lastNumber,
      key,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ----------------------- ✅ NEXT (LAST + 1, READ-ONLY) ----------------------- */
/**
 * GET /api/invoice/next?saleDate=2026-02-06
 * Returns last counter + 1 (but does NOT update DB)
 * If none exists yet, returns INV-ALRxx-0001
 */
router.get("/next", authenticate, async (req, res) => {
  try {
    const { saleDate } = req.query;
    const date = saleDate ? new Date(saleDate) : new Date();

    if (saleDate && Number.isNaN(date.getTime())) {
      return res.status(400).json({ success: false, error: "Invalid saleDate" });
    }

    const key = buildKey(date);

    const counter = await prisma.invoiceCounter.findUnique({
      where: { key },
      select: { currentNumber: true },
    });

    const lastNumber = counter?.currentNumber || 0;
    const nextNumber = lastNumber + 1;

    const invoiceNo = `${key}-${pad(nextNumber, 4)}`;

    return res.json({
      success: true,
      invoiceNo,
      lastNumber,
      nextNumber,
      key,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
