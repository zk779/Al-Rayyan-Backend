import express from "express";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
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

/* ------------------------------- 📋 ROUTES ------------------------------- */

// ✅ Get all users (with Role + Branch)
router.get("/", authenticate, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        role: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true, code: true } },
      },
    });
    res.json({ success: true, data: users });
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ success: false, error: "Failed to fetch users" });
  }
});

// ✅ Get single user by ID
router.get("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        role: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true, code: true } },
      },
    });

    if (!user)
      return res.status(404).json({ success: false, error: "User not found" });

    res.json({ success: true, data: user });
  } catch (err) {
    console.error("Error fetching user:", err);
    res.status(500).json({ success: false, error: "Failed to fetch user" });
  }
});

// ✅ Create new user (requires valid JWT)
router.post("/", authenticate, async (req, res) => {
  try {
    const { fullName, email, password, phone, roleId, branchId } = req.body;

    if (!fullName || !email || !password || !roleId || !branchId)
      return res.status(400).json({
        success: false,
        error: "fullName, email, password, roleId and branchId are required",
      });

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists)
      return res
        .status(400)
        .json({ success: false, error: "Email already registered" });

    // Validate role and branch existence
    const role = await prisma.role.findUnique({ where: { id: roleId } });
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!role) return res.status(400).json({ error: "Invalid roleId" });
    if (!branch) return res.status(400).json({ error: "Invalid branchId" });

    const hashed = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        fullName,
        email,
        password: hashed,
        phone,
        roleId,
        branchId,
      },
      include: {
        role: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true, code: true } },
      },
    });

    res.status(201).json({ success: true, data: user });
  } catch (err) {
    console.error("Error creating user:", err);
    res.status(500).json({ success: false, error: "Failed to create user" });
  }
});

// ✅ Update user info (password optional)
router.put("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, email, phone, password, roleId, branchId, isActive } =
      req.body;

    const data = { fullName, email, phone, roleId, branchId, isActive };
    if (password) data.password = await bcrypt.hash(password, 10);

    const user = await prisma.user.update({
      where: { id },
      data,
      include: {
        role: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true, code: true } },
      },
    });

    res.json({ success: true, data: user });
  } catch (err) {
    console.error("Error updating user:", err);
    res.status(500).json({ success: false, error: "Failed to update user" });
  }
});

// ✅ Delete user
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.user.delete({ where: { id } });
    res.json({ success: true, message: "User deleted successfully" });
  } catch (err) {
    console.error("Error deleting user:", err);
    res.status(500).json({ success: false, error: "Failed to delete user" });
  }
});

export default router;
