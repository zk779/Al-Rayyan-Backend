// Converts a "YYYY-MM-DD" LOCAL calendar date (as picked in a date picker)
// into the UTC instant range that covers that day — in whatever IANA
// timezone the request specifies (e.g. "Asia/Riyadh", "Asia/Karachi",
// "America/New_York"). No timezone is assumed by default: callers should
// pass the requesting client's own timezone so this works correctly across
// regions instead of baking in one office's offset.
// Falls back to UTC when no timezone is given or it's invalid.
//
// ─────────────────────────────────────────────────────────────────────────
// IMPORTANT: this uses `moment-timezone` (which bundles the full IANA tz
// database as plain data) instead of the native Intl API. The previous
// Intl-based version depended on the ICU timezone data compiled into the
// Node runtime — this worked locally but silently fell back to UTC in
// production, because the deployed Node runtime resolved/validated
// "Asia/Karachi" differently than local Node did (no error was thrown,
// so it went unnoticed and just returned wrong day boundaries).
// moment-timezone ships its own tz rules, so behavior is now guaranteed
// identical regardless of the host's ICU build, Node version, or
// serverless runtime — local and production will always agree.
// ─────────────────────────────────────────────────────────────────────────

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