import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();
const prisma = new PrismaClient();

async function main() {
  const adminEmail = "zk@admin.com";

  // 🔍 Check if admin already exists
  const existing = await prisma.user.findUnique({
    where: { email: adminEmail },
  });
  if (existing) {
    console.log("✅ Admin already exists.");
    return;
  }

  // 🔐 Hash password
  const hashed = await bcrypt.hash("321321", 10);

  // 🧩 Create or find ADMIN role
  const adminRole = await prisma.role.upsert({
    where: { name: "ADMIN" },
    update: {},
    create: {
      name: "ADMIN",
      description: "System Administrator",
      isActive: true,
    },
  });

  // 🧾 Fetch all permissions
  const allPermissions = await prisma.permission.findMany();
  if (allPermissions.length === 0) {
    console.log("⚠️ No permissions found. Please seed permissions first.");
  } else {
    // ✅ Assign all permissions to the ADMIN role
    for (const p of allPermissions) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: adminRole.id,
            permissionId: p.id,
          },
        },
        update: {},
        create: {
          roleId: adminRole.id,
          permissionId: p.id,
        },
      });
    }
    console.log(
      `🔗 Assigned ${allPermissions.length} permissions to ADMIN role`
    );
  }

  // 👤 Create default admin user
  await prisma.user.create({
    data: {
      fullName: "ZeeKay",
      email: adminEmail,
      password: hashed,
      roleId: adminRole.id,
    },
  });

  console.log("🎉 Default admin user created successfully!");
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error("❌ Error during seeding:", e);
    prisma.$disconnect();
  });
