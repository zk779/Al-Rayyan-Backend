import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

/* ============================================================
   PERMISSIONS
   ============================================================ */

const PERMISSIONS = [
  // --- Roles ---
  { name: "ROLE_CREATE", description: "Can create roles" },
  { name: "ROLE_READ", description: "Can view roles" },
  { name: "ROLE_EDIT", description: "Can edit roles" },
  { name: "ROLE_DELETE", description: "Can delete roles" },

  // --- Branches ---
  { name: "BRANCH_CREATE", description: "Can create branches" },
  { name: "BRANCH_READ", description: "Can view branches" },
  { name: "BRANCH_EDIT", description: "Can edit branches" },
  { name: "BRANCH_DELETE", description: "Can delete branches" },

  // --- Users ---
  { name: "USER_CREATE", description: "Can create users" },
  { name: "USER_READ", description: "Can view users" },
  { name: "USER_EDIT", description: "Can edit users" },
  { name: "USER_DELETE", description: "Can delete users" },

  // --- Vendors ---
  { name: "VENDOR_CREATE", description: "Can create vendors" },
  { name: "VENDOR_READ", description: "Can view vendors" },
  { name: "VENDOR_EDIT", description: "Can edit vendors" },
  { name: "VENDOR_DELETE", description: "Can delete vendors" },

  // --- Airlines ---
  { name: "AIRLINE_CREATE", description: "Can create airlines" },
  { name: "AIRLINE_READ", description: "Can view airlines" },
  { name: "AIRLINE_EDIT", description: "Can edit airlines" },
  { name: "AIRLINE_DELETE", description: "Can delete airlines" },

  // --- Sales ---
  { name: "SALE_CREATE", description: "Can create sales" },
  { name: "SALE_READ", description: "Can view sales" },
  { name: "SALE_EDIT", description: "Can edit sales" },
  { name: "SALE_DELETE", description: "Can delete sales" },

  // --- Expenses ---
  { name: "EXPENSE_CREATE", description: "Can create expenses" },
  { name: "EXPENSE_READ", description: "Can view expenses" },
  { name: "EXPENSE_EDIT", description: "Can edit expenses" },
  { name: "EXPENSE_DELETE", description: "Can delete expenses" },

  // --- Customers ---
  { name: "CUSTOMER_CREATE", description: "Can create customers" },
  { name: "CUSTOMER_READ", description: "Can view customers" },
  { name: "CUSTOMER_EDIT", description: "Can edit customers" },
  { name: "CUSTOMER_DELETE", description: "Can delete customers" },

  // --- Payments ---
  { name: "PAYMENT_CREATE", description: "Can record payments" },
  { name: "PAYMENT_READ", description: "Can view payments" },
  { name: "PAYMENT_EDIT", description: "Can edit payments" },
  { name: "PAYMENT_DELETE", description: "Can delete payments" },

  // --- Refunds ---
  { name: "REFUND_CREATE", description: "Can create refunds" },
  { name: "REFUND_READ", description: "Can view refunds" },
  { name: "REFUND_EDIT", description: "Can edit refunds" },
  { name: "REFUND_DELETE", description: "Can delete refunds" },

  // --- Ledger ---
  { name: "LEDGER_READ", description: "Can view ledger (read-only)" },

  // --- Reports ---
  { name: "REPORT_READ", description: "Can view reports (read-only)" },

  // --- Banks ---
  { name: "BANK_CREATE", description: "Can create banks" },
  { name: "BANK_READ", description: "Can view banks" },
  { name: "BANK_EDIT", description: "Can edit banks" },
  { name: "BANK_DELETE", description: "Can delete banks" },

  // --- Sales View Permissions ---
  { name: "SALE_VIEW_ALL", description: "Can view all sales" },
  {
    name: "SALE_VIEW_BRANCH",
    description: "Can view sales for their branch",
  },
  {
    name: "SALE_VIEW_OWN",
    description: "Can view only their own sales",
  },
];

/* ============================================================
   DEFAULT ADMIN USER
   ============================================================ */

const ADMIN_EMAIL = "zk@admin.com";
const ADMIN_PASSWORD = "321321";

/* ============================================================
   MAIN
   ============================================================ */

async function main() {
  console.log("🌱 Starting database seed...\n");

  /* ============================================================
     1. SEED PERMISSIONS
     ============================================================ */

  console.log("🔐 Seeding permissions...");

  const permissionRecords = [];

  for (const permission of PERMISSIONS) {
    const record = await prisma.permission.upsert({
      where: {
        name: permission.name,
      },
      update: {
        description: permission.description,
      },
      create: {
        name: permission.name,
        description: permission.description,
      },
    });

    permissionRecords.push(record);
  }

  console.log(
    `✅ ${permissionRecords.length} permissions created/updated.`
  );

  /* ============================================================
     2. CREATE ADMIN ROLE
     ============================================================ */

  console.log("\n👑 Creating/updating Admin role...");

  const adminRole = await prisma.role.upsert({
    where: {
      name: "Admin",
    },
    update: {
      description: "System Administrator",
      isActive: true,
    },
    create: {
      name: "Admin",
      description: "System Administrator",
      isActive: true,
    },
  });

  console.log(`✅ Admin role ready: ${adminRole.id}`);

  /* ============================================================
     3. ASSIGN ALL PERMISSIONS TO ADMIN ROLE
     ============================================================ */

  console.log("\n🔗 Assigning permissions to Admin role...");

  for (const permission of permissionRecords) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: adminRole.id,
          permissionId: permission.id,
        },
      },
      update: {},
      create: {
        roleId: adminRole.id,
        permissionId: permission.id,
      },
    });
  }

  console.log(
    `✅ Assigned all ${permissionRecords.length} permissions to Admin role.`
  );

  /* ============================================================
     4. VERIFY SALE_VIEW_ALL
     ============================================================ */

  const saleViewAll = permissionRecords.find(
    (permission) => permission.name === "SALE_VIEW_ALL"
  );

  if (saleViewAll) {
    console.log("✅ SALE_VIEW_ALL assigned to Admin role.");
  } else {
    console.log("⚠️ SALE_VIEW_ALL permission was not found.");
  }

  /* ============================================================
     5. CREATE / UPDATE ADMIN USER
     ============================================================ */

  console.log("\n👤 Creating/updating default admin user...");

  const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);

  const adminUser = await prisma.user.upsert({
    where: {
      email: ADMIN_EMAIL,
    },
    update: {
      fullName: "ZeeKay",
      password: hashedPassword,
      roleId: adminRole.id,
    },
    create: {
      fullName: "ZeeKay",
      email: ADMIN_EMAIL,
      password: hashedPassword,
      roleId: adminRole.id,
    },
  });

  console.log(`✅ Admin user ready: ${adminUser.email}`);

  /* ============================================================
     6. FINAL VERIFICATION
     ============================================================ */

  const adminWithPermissions = await prisma.role.findUnique({
    where: {
      id: adminRole.id,
    },
    include: {
      rolePermissions: {
        include: {
          permission: true,
        },
      },
    },
  });

  console.log("\n========================================");
  console.log("🎉 SEED COMPLETED SUCCESSFULLY");
  console.log("========================================");
  console.log(`👑 Role: ${adminWithPermissions?.name}`);
  console.log(
    `🔐 Permissions: ${adminWithPermissions?.rolePermissions.length ?? 0}`
  );
  console.log(`👤 User: ${adminUser.email}`);
  console.log(`🔑 Password: ${ADMIN_PASSWORD}`);
  console.log("========================================\n");
}

/* ============================================================
   RUN SEED
   ============================================================ */

main()
  .catch((error) => {
    console.error("\n❌ Error during seeding:");
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
