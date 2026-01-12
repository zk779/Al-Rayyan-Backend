import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

const router = express.Router();
const prisma = new PrismaClient();

// 🔒 Strong JWT Authentication Middleware
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ error: "Missing Authorization header" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 🧠 Verify user still exists and is active
    const user = await prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user || !user.isActive)
      return res.status(401).json({ error: "User is inactive or removed" });

    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError")
      return res
        .status(401)
        .json({ error: "Token expired, please log in again" });

    return res.status(401).json({ error: "Invalid token" });
  }
}

// ✅ Get all branches (valid JWT required)
router.get("/", authenticate, async (req, res) => {
  try {
    const branches = await prisma.branch.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: branches });
  } catch (err) {
    console.error("Error fetching branches:", err);
    res.status(500).json({ success: false, error: "Failed to fetch branches" });
  }
});

// ✅ Create new branch (valid JWT required)
router.post("/", authenticate, async (req, res) => {
  try {
    const { name, code, address, city, country, phone, email } = req.body;

    if (!name || !code)
      return res
        .status(400)
        .json({ success: false, error: "Name and code are required" });

    const exists = await prisma.branch.findUnique({ where: { code } });
    if (exists)
      return res
        .status(400)
        .json({ success: false, error: "Branch code already exists" });

    const branch = await prisma.branch.create({
      data: { name, code, address, city, country, phone, email },
    });

    res.status(201).json({ success: true, data: branch });
  } catch (err) {
    console.error("Error creating branch:", err);
    res.status(500).json({ success: false, error: "Failed to create branch" });
  }
});

// ✅ Update branch (valid JWT required)
router.put("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, address, city, country, phone, email, isActive } =
      req.body;

    const branch = await prisma.branch.update({
      where: { id },
      data: { name, code, address, city, country, phone, email, isActive },
    });

    res.json({ success: true, data: branch });
  } catch (err) {
    console.error("Error updating branch:", err);
    res.status(500).json({ success: false, error: "Failed to update branch" });
  }
});

// ✅ Delete branch (valid JWT required)
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.branch.delete({ where: { id } });
    res.json({ success: true, message: "Branch deleted successfully" });
  } catch (err) {
    console.error("Error deleting branch:", err);
    res.status(500).json({ success: false, error: "Failed to delete branch" });
  }
});

export default router;
