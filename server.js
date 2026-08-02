import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

import roleRoutes from "./routes/roles.js";
import branchRoutes from "./routes/branches.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import airlineRoutes from "./routes/airlines.js";
import vendorsRoutes from "./routes/vendors.js";
import saleRouets from "./routes/sales.js";
import permissionRoutes from "./routes/permissions.js";
import LedgerRoutes from "./routes/Ledger.js";
import customerRoutes from "./routes/customers.js";
import destinationsRouter from "./routes/destinations.js";
import invoiceCounterRoutes from "./routes/invoiceCounter.js";
import refundsRoutes from "./routes/refunds.js";
import bankRoutes from "./routes/bankRoutes.js";
import vendorCustomerPaymentRoutes from "./routes/Vendorcustomerpayment.js";
import expenseRoutes from "./routes/expenseRoutes.js";
import salePaymentRoutes from "./routes/SalePayment.js";
import ReportRoutes from "./routes/reports.js";

dotenv.config();

const app = express();
const prisma = new PrismaClient();

// ✅ CORS must come BEFORE routes
const allowedOrigins = [
	"https://al-rayyan-backend-eight.vercel.app",
	"http://localhost:5173",
	"http://127.0.0.1:5173",
];

app.use(
	cors({
		origin: (origin, cb) => {
			// Allow server-to-server, Postman, curl
			if (!origin) return cb(null, true);

			// Allow local dev
			if (allowedOrigins.includes(origin)) {
				return cb(null, true);
			}

			// ✅ Allow ALL Vercel preview & production URLs
			if (origin.endsWith(".vercel.app")) {
				return cb(null, true);
			}

			return cb(new Error(`CORS blocked for origin: ${origin}`));
		},
		credentials: true,
		methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowedHeaders: ["Content-Type", "Authorization"],
	})
);

// ✅ Preflight handler

// Other middlewares
app.use(helmet());
app.use(morgan("dev"));

// Body parsers
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Routes (AFTER cors)
app.use("/api/roles", roleRoutes);
app.use("/api/permissions", permissionRoutes);
app.use("/api/branches", branchRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/airlines", airlineRoutes);
app.use("/api/vendors", vendorsRoutes);
app.use("/api/sales", saleRouets);
app.use("/api/ledger", LedgerRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/destinations", destinationsRouter);
app.use("/api/invoice", invoiceCounterRoutes);
app.use("/api/refunds",refundsRoutes);
app.use("/api/banks", bankRoutes);
app.use("/api/payments/vendor-customer", vendorCustomerPaymentRoutes);
app.use("/api/salePayment", salePaymentRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/reports", ReportRoutes);
// Root Route
app.get("/", (req, res) => {
	res.send(
		"🚀 Travel Agency Repository System API (MongoDB + Prisma) is Running ✅"
	);
});

// Test DB Route
app.get("/test-db", async (req, res) => {
	try {
		const roles = await prisma.role.findMany();
		res.json({ success: true, roles });
	} catch (err) {
		console.error("DB Error:", err);
		res.status(500).json({ success: false, error: "Database query failed" });
	}
});

// Global Error Handler
app.use((err, req, res, next) => {
	console.error("Unhandled Error:", err);
	res.status(500).json({ error: err.message || "Internal Server Error" });
});

// DB connect
(async () => {
	try {
		await prisma.$connect();
		console.log("✅ MongoDB connected successfully via Prisma");
	} catch (err) {
		console.error("❌ MongoDB connection failed:", err);
	}
})();

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
	console.log(`🚀 Server running on http://localhost:${PORT}`);
});
