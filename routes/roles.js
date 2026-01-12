import express from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

const router = express.Router();
const prisma = new PrismaClient();

// ✅ JWT authentication middleware (your latest one)
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ error: "Missing Authorization header" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Verify user still active
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

// ✅ Get all roles with their permissions
// ✅ Get all roles (flattened response: only permission names)
router.get("/", authenticate, async (req, res) => {
  try {
    const roles = await prisma.role.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        permissionLinks: {
          include: {
            permission: {
              select: { name: true },
            },
          },
        },
      },
    });

    // ✅ Flatten and remove permissionLinks
    const formatted = roles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      isActive: role.isActive,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
      permissions: role.permissionLinks.map((link) => link.permission.name),
    }));

    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error("Error fetching roles:", err);
    res.status(500).json({ success: false, error: "Failed to fetch roles" });
  }
});

// ✅ Create new role and assign permissions
router.post("/", authenticate, async (req, res) => {
  try {
    const { name, description, permissionIds = [] } = req.body;

    if (!name)
      return res
        .status(400)
        .json({ success: false, error: "Name is required" });

    const exists = await prisma.role.findUnique({ where: { name } });
    if (exists)
      return res
        .status(400)
        .json({ success: false, error: "Role name already exists" });

    const role = await prisma.role.create({
      data: { name, description },
    });

    // attach permissions via RolePermission
    for (const pid of permissionIds) {
      await prisma.rolePermission.create({
        data: {
          roleId: role.id,
          permissionId: pid,
        },
      });
    }

    // fetch role again with linked permissions
    const fullRole = await prisma.role.findUnique({
      where: { id: role.id },
      include: {
        permissionLinks: { include: { permission: true } },
      },
    });

    const formatted = {
      ...fullRole,
      permissions: fullRole.permissionLinks.map((link) => link.permission),
    };

    res.status(201).json({ success: true, data: formatted });
  } catch (err) {
    console.error("Error creating role:", err);
    res.status(500).json({ success: false, error: "Failed to create role" });
  }
});

// ✅ Get single role by ID (with full permission details)
router.get("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const role = await prisma.role.findUnique({
      where: { id },
      include: {
        permissionLinks: {
          include: {
            permission: {
              select: {
                id: true,
                name: true,
                description: true,
                createdAt: true,
              },
            },
          },
        },
        users: {
          select: { id: true, fullName: true, email: true, isActive: true },
        },
      },
    });

    if (!role)
      return res.status(404).json({ success: false, error: "Role not found" });

    // ✅ Format: flatten permissions + include related users
    const formatted = {
      id: role.id,
      name: role.name,
      description: role.description,
      isActive: role.isActive,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
      permissions: role.permissionLinks.map((link) => link.permission),
      users: role.users,
    };

    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error("Error fetching role details:", err);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch role details" });
  }
});

// ✅ Update role and permissions
router.put("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, isActive, permissionIds = [] } = req.body;

    // update role info
    await prisma.role.update({
      where: { id },
      data: { name, description, isActive },
    });

    // clear old permissions and reassign
    await prisma.rolePermission.deleteMany({ where: { roleId: id } });

    for (const pid of permissionIds) {
      await prisma.rolePermission.create({
        data: { roleId: id, permissionId: pid },
      });
    }

    // fetch updated role
    const updatedRole = await prisma.role.findUnique({
      where: { id },
      include: { permissionLinks: { include: { permission: true } } },
    });

    const formatted = {
      ...updatedRole,
      permissions: updatedRole.permissionLinks.map((link) => link.permission),
    };

    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error("Error updating role:", err);
    res.status(500).json({ success: false, error: "Failed to update role" });
  }
});

// ✅ Delete role
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.rolePermission.deleteMany({ where: { roleId: id } });
    await prisma.role.delete({ where: { id } });

    res.json({ success: true, message: "Role deleted successfully" });
  } catch (err) {
    console.error("Error deleting role:", err);
    res.status(500).json({ success: false, error: "Failed to delete role" });
  }
});

export default router;
