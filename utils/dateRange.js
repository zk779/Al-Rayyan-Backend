import moment from "moment-timezone";

const FALLBACK_TIMEZONE = "UTC";

function isValidTimeZone(timeZone) {
	return !!timeZone && moment.tz.zone(timeZone) !== null;
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

	let zone = FALLBACK_TIMEZONE;
	if (timeZone) {
		if (isValidTimeZone(timeZone)) {
			zone = timeZone;
		} else {
			// Fail LOUDLY (in logs) instead of silently — this is exactly
			// what masked the local-vs-production discrepancy last time.
			console.warn(
				`[localDayRangeToUtc] Unknown/unsupported timezone "${timeZone}", falling back to UTC`
			);
		}
	}

	const [, yStr, mStr, dStr] = match;
	const dateOnly = `${yStr}-${mStr}-${dStr}`;

	// Start of the local calendar day, expressed as a UTC instant.
	const start = moment.tz(dateOnly, "YYYY-MM-DD", zone).startOf("day");

	// End = start of the NEXT local day minus 1ms — correct even on days
	// that aren't exactly 24h long (DST transitions), since moment-timezone
	// recomputes the offset for the next day independently.
	const end = start.clone().add(1, "day").subtract(1, "millisecond");

	if (!start.isValid() || !end.isValid()) return null;

	return { start: start.toDate(), end: end.toDate() };
}