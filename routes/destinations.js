import express from "express";
import { AIRPORTS } from "../airports.service.js";
import { searchCities } from "../cities.service.js";

const router = express.Router();

/**
	* GET /api/destinations/search?q=LHE
	* GET /api/destinations/search?q=lahore
	*/
router.get("/search", (req, res) => {
	const { q, limit = 20 } = req.query;

	if (!q) {
		return res.status(400).json({
			success: false,
			error: "Search query (q) is required",
		});
	}

	const query = q.toString().trim().toLowerCase();

	const results = AIRPORTS.filter((a) =>
		a.iata?.toLowerCase() === query || // exact IATA
		a.iata?.toLowerCase().startsWith(query)
	).slice(0, Number(limit));

	res.json({
		success: true,
		count: results.length,
		data: results,
	});
});

/**
 * GET /api/destinations/cities?q=makkah
 * Every city/town of the world by any of its names (Makkah / Mecca, Madinah / Medina …) with its
 * country — for hotel bookings, where the place needn't have an airport.
 */
router.get("/cities", (req, res) => {
	const { q, limit = 20 } = req.query;

	if (!q) {
		return res.status(400).json({
			success: false,
			error: "Search query (q) is required",
		});
	}

	const results = searchCities(q.toString(), Number(limit));

	res.json({
		success: true,
		count: results.length,
		data: results,
	});
});

export default router;
