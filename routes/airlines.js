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

/* ------------------------------- 📋 ROUTES ------------------------------- */

// ✅ Get all airline codes
router.get("/", authenticate, async (req, res) => {
  try {
    const airlines = await prisma.airlineCode.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: airlines });
  } catch (err) {
    console.error("Error fetching airlines:", err);
    res.status(500).json({ success: false, error: "Failed to fetch airlines" });
  }
});

// ✅ Get airline by ID
router.get("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const airline = await prisma.airlineCode.findUnique({ where: { id } });
    if (!airline)
      return res
        .status(404)
        .json({ success: false, error: "Airline not found" });

    res.json({ success: true, data: airline });
  } catch (err) {
    console.error("Error fetching airline:", err);
    res.status(500).json({ success: false, error: "Failed to fetch airline" });
  }
});

// ✅ Create new airline
router.post("/", authenticate, async (req, res) => {
  try {
    const { airlineName, iataName, airlineCode, status } = req.body;

    if (!airlineName || !airlineCode)
      return res
        .status(400)
        .json({ success: false, error: "Airline Name and Code are required" });

    const exists = await prisma.airlineCode.findUnique({
      where: { airlineCode },
    });
    if (exists)
      return res
        .status(400)
        .json({ success: false, error: "Airline Code already exists" });

    const airline = await prisma.airlineCode.create({
      data: { airlineName, iataName, airlineCode, status },
    });

    res.status(201).json({ success: true, data: airline });
  } catch (err) {
    console.error("Error creating airline:", err);
    res.status(500).json({ success: false, error: "Failed to create airline" });
  }
});

// ✅ Update airline
router.put("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { airlineName, iataName, airlineCode, status } = req.body;

    const airline = await prisma.airlineCode.update({
      where: { id },
      data: { airlineName, iataName, airlineCode, status },
    });

    res.json({ success: true, data: airline });
  } catch (err) {
    console.error("Error updating airline:", err);
    res.status(500).json({ success: false, error: "Failed to update airline" });
  }
});

// ✅ Delete airline
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.airlineCode.delete({ where: { id } });
    res.json({ success: true, message: "Airline deleted successfully" });
  } catch (err) {
    console.error("Error deleting airline:", err);
    res.status(500).json({ success: false, error: "Failed to delete airline" });
  }
});

export default router;
