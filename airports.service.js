import fs from "fs";
import path from "path";

const filePath = path.join(process.cwd(), "./airports.json");
const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));

// Normalize into array (easier to search)
export const AIRPORTS = Object.values(raw).map((a) => ({
	iata: a.airportCodeIata || a.meta?.iataCode,
	icao: a.meta?.icaoCode,
	name: a.airportName,
	city: a.cityName,
	country: a.countryCode,
	region: a.region,
	lat: a.meta?.latitudeDegreeNum,
	lng: a.meta?.longitudeDegreeNum,
	timezone: a.meta?.timeZoneDesc,
}));
