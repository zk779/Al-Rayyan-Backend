import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const router = express.Router();
const prisma = new PrismaClient();

// 🛡️ Reusable Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Authorization token missing",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // Attach the payload (e.g., { id: "..." }) to the request
    next();
  } catch (err) {
    console.error("Token authentication middleware error:", err);
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, error: "Token expired" });
    }
    return res.status(401).json({ success: false, error: "Invalid token" });
  }
};

// ✅ Login API
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required"
      });
    }

    // 🔍 Find user by email
    const user = await prisma.user.findUnique({
      where: { email },
      include: { role: true, branch: true },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Invalid email or password"
      });
    }

    // 🛑 Block deactivated users from logging in
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        error: "Your account has been deactivated. Please contact your administrator.",
      });
    }

    // 🔑 Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: "Invalid email or password"
      });
    }

    // 🧾 Create token payload
    const payload = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role?.name || "USER",

      branchId: user.branchId,
      branchName: user.branch?.name || null,
    };

    // 🔐 Generate JWT (Note: Changed your comment to match the actual '1d' expiration)
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "1d", // valid for 24 hours
    });

    // ✅ Return user info and token
    return res.json({
      success: true,
      message: "Login successful",
      token,
      user: payload,
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({
      success: false,
      error: "Server error during login"
    });
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
      user: decoded,
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

// ✅ Get Profile & Permissions API

router.get("/me", authenticateToken, async (req, res) => {
  try {
    // 🗄️ Fetch the latest user state, role, and permission mappings
    const userProfile = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        branch: true,
        role: {
          include: {
            permissionLinks: {
              include: {
                permission: true,
              },
            },
          },
        },
      },
    });

    // 🛑 Verify user hasn't been removed or deactivated since token issuance
    if (!userProfile || !userProfile.isActive) {
      return res.status(401).json({
        success: false,
        error: "User account is inactive or no longer exists",
      });
    }

    // 🔑 Flatten permission connections into a clean string layout
    const permissions = userProfile.role?.permissionLinks.map(
      (link) => link.permission.name
    ) || [];

    // 🔄 Reissue a fresh token (sliding expiry) — same payload shape as /verify
    const freshToken = jwt.sign(
      {
        id: userProfile.id,
        email: userProfile.email,
        fullName: userProfile.fullName,
        role: userProfile.role?.name || "USER",
        branchId: userProfile.branchId,
        branchName: userProfile.branch?.name || null,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" } // match /login's expiry exactly
    );

    // ✅ Return clean user state, permissions, and refreshed token
    return res.json({
      success: true,
      message: "Token is valid",
      token: freshToken,
      user: {
        id: userProfile.id,
        fullName: userProfile.fullName,
        email: userProfile.email,
        phone: userProfile.phone,
        role: userProfile.role?.name || null,
        branch: userProfile.branch
          ? {
            id: userProfile.branch.id,
            name: userProfile.branch.name,
            code: userProfile.branch.code,
          }
          : null,
        createdAt: userProfile.createdAt,
      },
      permissions,
    });
  } catch (err) {
    console.error("Fetch profile /me error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error while fetching user profile",
    });
  }
});

export default router;