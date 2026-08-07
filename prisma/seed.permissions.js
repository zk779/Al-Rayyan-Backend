import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

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

  // --- Ledger (Read Only) ---
  { name: "LEDGER_READ", description: "Can view ledger (read-only)" },

  // --- Report (Read Only) ---
  { name: "REPORT_READ", description: "Can view reports (read-only)" },

  //---- Banks ---
  { name: "BANK_CREATE", description: "Can create banks" },
  { name: "BANK_READ", description: "Can view banks" },
  { name: "BANK_EDIT", description: "Can edit banks" },
  { name: "BANK_DELETE", description: "Can delete banks" },

  //--- Sales View Permissions 
  { name: "SALE_VIEW_ALL", description: "Can view all sales" },
  { name: "SALE_VIEW_BRANCH", description: "Can view sales for their branch" },
  { name: "SALE_VIEW_OWN", description: "Can view only their own sales" },
];

async function main() {
  console.log("🌱 Seeding permissions...");
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { name: p.name },
      update: { description: p.description },
      create: p,
    });
  }
  console.log(`✅ Seeded ${PERMISSIONS.length} permissions successfully.`);
}

main()
  .catch((e) => {
    console.error("❌ Error seeding permissions:", e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
