import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// City search for hotel bookings: every city and town of the world (GeoNames, 5,000+ people),
// not just places with an airport. Built by scripts/build-cities.mjs into data/cities.json —
// searched in memory, nothing is called at runtime. Data © GeoNames (CC BY 4.0), geonames.org.

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "cities.json");

const fold = (s) =>
	String(s)
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/['’`ʼʻ]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

// "Al Madinah" / "At Ta'if" / "Ad Dammam": people leave the article off, so index both forms
const ARTICLE = /^(?:al|el|ad|ar|as|at|an|az|ash|ath|adh|ed|er|es|et) (?=.)/;

const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const countryName = (cc) => {
	try {
		return countryNames.of(cc) || cc;
	} catch {
		return cc;
	}
};

let cities = [];
// parallel arrays: one entry per searchable name
const keyText = []; // folded
const keyCity = []; // index into cities
const keyOrig = []; // the name as written
const keyPrimary = []; // 1 when it is the place's official name, 0 for an alternate spelling

try {
	cities = JSON.parse(fs.readFileSync(file, "utf-8"));
} catch (err) {
	console.error(`⚠️  City data missing (${file}) — run scripts/build-cities.mjs. Hotel city search is empty.`, err.message);
}

cities.forEach((c, i) => {
	const [, name, , , , , alts] = c;
	const names = alts ? [name, ...alts.split("|")] : [name];
	const done = new Set();
	for (const n of names) {
		const k = fold(n);
		for (const form of [k, k.replace(ARTICLE, "")]) {
			if (form && !done.has(form)) {
				done.add(form);
				keyText.push(form);
				keyCity.push(i);
				keyOrig.push(n);
				keyPrimary.push(n === name ? 1 : 0);
			}
		}
	}
});

const LATIN = /^[\p{Script=Latin}\p{N}\s'’.\-]+$/u;

/**
 * Searches by any known spelling of a place (Makkah / Mecca, Madinah / Medina, Taif …) in Latin or
 * Arabic script. Best matches first: exact name (any spelling), then official names that start with the
 * query, then other spellings that do, then names with a word that starts with it; within each, bigger
 * places first.
 * Returns [{ id, city, country, countryName, population, lat, lng, alsoKnownAs }].
 */
export function searchCities(query, limit = 20) {
	const q = fold(query || "");
	if (q.length < 2) return [];

	const best = new Map(); // city index -> { tier, key }
	for (let k = 0; k < keyText.length; k++) {
		const t = keyText[k];
		let tier;
		if (t === q) tier = 0; // any spelling, exactly
		else if (t.startsWith(q)) tier = keyPrimary[k] ? 1 : 2; // official name first, then other spellings
		else if (q.length >= 3 && t.includes(` ${q}`)) tier = 3;
		else continue;
		const ci = keyCity[k];
		const cur = best.get(ci);
		if (!cur || tier < cur.tier) best.set(ci, { tier, key: k });
	}

	return [...best.entries()]
		.sort((a, b) => a[1].tier - b[1].tier || cities[b[0]][3] - cities[a[0]][3])
		.slice(0, Math.max(1, Math.min(Number(limit) || 20, 50)))
		.map(([ci, { key }]) => {
			const [id, name, cc, population, lat, lng] = cities[ci];
			const matched = keyOrig[key];
			return {
				id,
				city: name,
				country: cc,
				countryName: countryName(cc),
				population,
				lat,
				lng,
				// the spelling that was typed, when it isn't the official one (Mecca for Makkah)
				alsoKnownAs: fold(matched) !== fold(name) && LATIN.test(matched) ? matched : null,
			};
		});
}

export const CITY_COUNT = cities.length;
