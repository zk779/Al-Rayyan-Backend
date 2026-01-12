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

// ✅ Get all permissions (lightweight)
router.get("/", authenticate, async (req, res) => {
  try {
    const permissions = await prisma.permission.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true, // permission name (e.g. USER_READ)
        description: true,
      },
    });

    // If you want key name as "permission" instead of "name"
    const data = permissions.map((p) => ({
      id: p.id,
      permission: p.name,
      description: p.description,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error("Error fetching permissions:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch permissions" });
  }
});

export default router;
