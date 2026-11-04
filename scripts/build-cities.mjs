// Builds data/cities.json (used by cities.service.js for the hotel city search) from a
// GeoNames city dump — https://download.geonames.org/export/dump/ (CC BY 4.0, free).
//
//   1. download + unzip cities5000.zip (every place with 5,000+ people; cities1000 / cities15000
//      work the same way)
//   2. node scripts/build-cities.mjs path/to/cities5000.txt
//
// Each row of the dump is tab separated: geonameid, name, asciiname, alternatenames (comma
// separated), latitude, longitude, feature class, feature code, country code, cc2, admin1 …
// population (col 14). Only what the search needs is kept, as compact arrays:
//   [geonameid, name, countryCode, population, lat, lng, "alt name|alt name|…"]
// Alternate names matter: GeoNames lists "Mecca", "La Meca", "مكة", … for Makkah, so a
// search by any of them finds it.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const input = process.argv[2];
if (!input) {
	console.error("usage: node scripts/build-cities.mjs <path to cities5000.txt>");
	process.exit(1);
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "cities.json");

const MAX_ALTS = 40;
// Latin and Arabic script (what this agency's users type), digits, space and common name punctuation
const KEEP = /^[\p{Script=Latin}\p{Script=Arabic}\p{N}\s'’.\-]+$/u;
const fold = (s) =>
	s
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/['’`ʼʻ]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

const rows = fs
	.readFileSync(input, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => l.split("\t"));

let altCount = 0;
const cities = rows.map((r) => {
	const [id, name, ascii, alternates, lat, lng, , , cc, , , , , , population] = r;
	const seen = new Set([fold(name), fold(ascii)]);
	const alts = [];
	for (const a of alternates.split(",")) {
		const alt = a.trim();
		if (!alt || alt.length > 40 || !KEEP.test(alt)) continue;
		const k = fold(alt);
		if (!k || seen.has(k)) continue;
		seen.add(k);
		alts.push(alt);
		if (alts.length >= MAX_ALTS) break;
	}
	altCount += alts.length;
	return [Number(id), name, cc, Number(population) || 0, Number(Number(lat).toFixed(4)), Number(Number(lng).toFixed(4)), alts.join("|")];
});

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(cities));
console.log(`${cities.length} places, ${altCount} alternate names -> ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
