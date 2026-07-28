// Converts a "YYYY-MM-DD" LOCAL calendar date (as picked in a date picker)
// into the UTC instant range that covers that day — in whatever IANA
// timezone the request specifies (e.g. "Asia/Riyadh", "Asia/Karachi",
// "America/New_York"). No timezone is assumed by default: callers should
// pass the requesting client's own timezone (e.g. from
// `Intl.DateTimeFormat().resolvedOptions().timeZone` in the browser) so this
// works correctly across regions instead of baking in one office's offset.
// Falls back to UTC when no timezone is given or it's invalid.
//
// Implemented with the native Intl API (no moment/luxon dependency) so DST
// is handled correctly for zones that observe it.

const FALLBACK_TIMEZONE = "UTC";

function isValidTimeZone(timeZone) {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}

// Offset (ms) such that: localWallClockMs = utcInstantMs + offset
function getTimeZoneOffsetMs(utcDate, timeZone) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(utcDate).reduce((acc, p) => {
		if (p.type !== "literal") acc[p.type] = p.value;
		return acc;
	}, {});

	const wallClockAsUtcMs = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		parts.hour === "24" ? 0 : Number(parts.hour),
		Number(parts.minute),
		Number(parts.second),
	);

	return wallClockAsUtcMs - utcDate.getTime();
}

// Two passes so the correct offset is picked even right around a DST
// transition (the offset can differ depending on which side you guess).
function localMidnightToUtcMs(year, month, day, timeZone) {
	let guessMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
	for (let i = 0; i < 2; i++) {
		const offset = getTimeZoneOffsetMs(new Date(guessMs), timeZone);
		guessMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offset;
	}
	return guessMs;
}

/**
 * @param {string} dateStr - "YYYY-MM-DD" local calendar date
 * @param {string} [timeZone] - IANA timezone name, e.g. "Asia/Riyadh"
 * @returns {{start: Date, end: Date} | null}
 */
export function localDayRangeToUtc(dateStr, timeZone) {
	if (!dateStr) return null;

	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
	if (!match) return null;

	const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : FALLBACK_TIMEZONE;
	const [, yStr, mStr, dStr] = match;
	const year = Number(yStr);
	const month = Number(mStr);
	const day = Number(dStr);

	const startMs = localMidnightToUtcMs(year, month, day, zone);

	// Next calendar day (let Date roll over month/year boundaries), so the
	// range is exactly "start of this local day" to "start of next local
	// day minus 1ms" — correct even on days that aren't exactly 24h long.
	const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
	const endMs = localMidnightToUtcMs(
		nextDay.getUTCFullYear(),
		nextDay.getUTCMonth() + 1,
		nextDay.getUTCDate(),
		zone,
	) - 1;

	const start = new Date(startMs);
	const end = new Date(endMs);
	if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;

	return { start, end };
}
