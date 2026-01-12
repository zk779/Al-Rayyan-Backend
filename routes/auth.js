import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

// ✅ Login API
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: "Email and password are required" });

    // 🔍 Find user by email
    const user = await prisma.user.findUnique({
      where: { email },
      include: { role: true, branch: true },
    });

    if (!user)
      return res.status(401).json({ error: "Invalid email or password" });

    // 🔑 Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(401).json({ error: "Invalid email or password" });

    // 🧾 Create token payload
    const payload = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role?.name || "USER",
      branch: user.branch?.name || null,
    };

    // 🔐 Generate JWT
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "1d", // valid for 7 days
    });

    // ✅ Return user info and token
    res.json({
      success: true,
      message: "Login successful",
      token,
      user: payload,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error during login" });
  }
});

// ✅ Verify Token API
router.post("/verify", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    // 🔴 Token missing
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authorization token missing",
      });
    }

    const token = authHeader.split(" ")[1];

    // 🔍 Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ✅ Token valid
    return res.json({
      success: true,
      message: "Token is valid",
      token,
      user: decoded, // same payload you signed during login
    });
  } catch (err) {
    console.error("Token verification error:", err);

    // ⏰ Token expired
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        error: "Token expired",
      });
    }

    // ❌ Invalid token
    return res.status(401).json({
      success: false,
      error: "Invalid token",
    });
  }
});

export default router;
