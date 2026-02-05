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

// ✅ Bulk Create Airlines (Skips duplicates based on iataName)
router.post("/bulk", authenticate, async (req, res) => {
  try {
    const airlines = req.body;

    // 1. Basic Validation to prevent empty processing
    if (!Array.isArray(airlines) || airlines.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: "Request body must be a non-empty array." 
      });
    }

    // 2. Map data directly
    const dataToInsert = airlines.map(airline => ({
      airlineName: airline.airlineName,
      airlineCode: airline.airlineCode,
      iataName: airline.iataName,
      icao_code: airline.icao_code,
      country_territory: airline.country_territory,
      // Fixed logic: Use the boolean directly or default to true
      status: typeof airline.status === 'boolean' ? airline.status : true,
    }));

    // 3. Execute Bulk Insert
    // Note: In MongoDB, if any record violates a unique constraint, 
    // the entire operation will fail unless you use a different pattern.
    const result = await prisma.airlineCode.createMany({
      data: dataToInsert,
    });

    // 4. Send response immediately to prevent timeout retries
    return res.status(201).json({ 
      success: true, 
      count: result.count 
    });

  } catch (err) {
    console.error("Bulk Insert Error:", err);
    
    // Handle unique constraint violations specifically for MongoDB
    if (err.code === 'P2002') {
      return res.status(409).json({ 
        success: false, 
        error: "One or more airlines already exist (Unique constraint violation)." 
      });
    }

    return res.status(500).json({ 
      success: false, 
      error: "Internal Server Error during bulk upload." 
    });
  }
});
// ✅ Update all airlines to status: true
// ✅ Update Status by Array of IDs
router.patch("/status/set-selected", authenticate, async (req, res) => {
  try {
    const { ids, targetStatus } = req.body; // ids: [], targetStatus: true/false

    const result = await prisma.airlineCode.updateMany({
      where: { id: { in: ids } },
      data: { status: targetStatus },
    });

    res.json({ success: true, count: result.count, message: `Updated ${result.count} records.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ------------------------------- 📋 ROUTES ------------------------------- */

// ✅ Get all airline codes
router.get("/", authenticate, async (req, res) => {
  try {
    const airlines = await prisma.airlineCode.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: airlines });
  } catch (err) {
    console.error("Error fetching airlines:", err);
    res.status(500).json({ success: false, error: "Failed to fetch airlines" });
  }
});

// ✅ Get airline by ID
router.get("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const airline = await prisma.airlineCode.findUnique({ where: { id } });
    if (!airline)
      return res
        .status(404)
        .json({ success: false, error: "Airline not found" });

    res.json({ success: true, data: airline });
  } catch (err) {
    console.error("Error fetching airline:", err);
    res.status(500).json({ success: false, error: "Failed to fetch airline" });
  }
});

// ✅ Create new airline
router.post("/", authenticate, async (req, res) => {
  try {
    const { airlineName, iataName, airlineCode, status } = req.body;

    if (!airlineName || !airlineCode)
      return res
        .status(400)
        .json({ success: false, error: "Airline Name and Code are required" });

    const exists = await prisma.airlineCode.findUnique({
      where: { airlineCode },
    });
    if (exists)
      return res
        .status(400)
        .json({ success: false, error: "Airline Code already exists" });

    const airline = await prisma.airlineCode.create({
      data: { airlineName, iataName, airlineCode, status },
    });

    res.status(201).json({ success: true, data: airline });
  } catch (err) {
    console.error("Error creating airline:", err);
    res.status(500).json({ success: false, error: "Failed to create airline" });
  }
});

// ✅ Update airline
router.put("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { airlineName, iataName, airlineCode, status } = req.body;

    const airline = await prisma.airlineCode.update({
      where: { id },
      data: { airlineName, iataName, airlineCode, status },
    });

    res.json({ success: true, data: airline });
  } catch (err) {
    console.error("Error updating airline:", err);
    res.status(500).json({ success: false, error: "Failed to update airline" });
  }
});

// ✅ Delete airline
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.airlineCode.delete({ where: { id } });
    res.json({ success: true, message: "Airline deleted successfully" });
  } catch (err) {
    console.error("Error deleting airline:", err);
    res.status(500).json({ success: false, error: "Failed to delete airline" });
  }
});

// ✅ Delete specific airlines by array of IDs OR delete all if array is empty
router.delete("/deleteMany", authenticate, async (req, res) => {
  try {
    const { ids } = req.body; // Expecting { "ids": ["id1", "id2"] } or { "ids": [] }

    let filter = {};

    // If ids is provided and has items, target those specific IDs
    if (Array.isArray(ids) && ids.length > 0) {
      filter = {
        id: {
          in: ids,
        },
      };
    } 
    // If ids is an empty array, 'filter' remains {} which deletes everything

    const result = await prisma.airlineCode.deleteMany({
      where: filter,
    });

    res.json({
      success: true,
      message: ids?.length > 0 
        ? `${result.count} selected airlines deleted.` 
        : "All airlines have been deleted.",
      count: result.count,
    });
  } catch (err) {
    console.error("Error during deletion:", err);
    res.status(500).json({ 
      success: false, 
      error: "Failed to delete airlines" 
    });
  }
});

export default router;
