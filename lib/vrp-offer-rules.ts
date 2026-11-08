// Offer rules beyond the signature (VRP Core v0.1 §5, §6, §7; vrp-spec ADR 0012).
//
// The rules a verifier applies to the signed payload's `generated_at`,
// `valid_until` and `request` once the signature has been checked:
//   - `generated_at` and `valid_until` are UTC date-times in the schema's form
//     (RFC 3339 `date-time`, ending in Z) that exist in the calendar;
//   - `valid_until` is later than `generated_at` and at most 900 seconds after
//     it, compared as written, fractions of a second included (§5);
//   - `generated_at` is at most 60 seconds ahead of the verifier's clock, and
//     `valid_until` has not passed (§6);
//   - `request.check_in` and `request.check_out` exist in the calendar,
//     `check_out` is later than `check_in`, and `check_in` is not earlier than
//     the day before the verifier's UTC date (§5, §7);
//   - `request.language`, when present, is a language tag of the form §5 gives;
//   - `request.check_in`, `check_out` and `guests` are the stay the agent asked
//     for (§7). A verifier that does not know what was asked for cannot pass
//     this rule (§8: fail closed).
//
// The reason codes and their order are those of the VRP offer-rules conformance
// vectors (vrp-spec examples/conformance/offer-rules/vectors.v0.1.json, a
// byte-identical copy at spec/vectors/offer-rules.v0.1.json), so a result here
// compares directly with the standard's own check.

export const MAX_LIFETIME_SECONDS = 900;
export const CLOCK_SKEW_SECONDS = 60;
// §5: language subtag (2–3 letters), optional script (4 letters), optional
// region (2 letters or 3 digits). Free text never matches. "(?!\n)" keeps an
// engine whose "$" also matches before a final line break exact.
export const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?$(?!\n)/;

export type OfferRuleCode =
  | "malformed_generated_at"
  | "malformed_valid_until"
  | "lifetime_not_positive"
  | "lifetime_too_long"
  | "generated_at_in_future"
  | "expired"
  | "request_missing"
  | "invalid_check_in"
  | "invalid_check_out"
  | "check_out_not_after_check_in"
  | "check_in_in_past"
  | "invalid_language"
  | "asked_stay_unknown"
  | "request_mismatch"
  | "clock_unusable";

/** The stay the agent asked the offer endpoint for (Core §4). */
export type AskedStay = { check_in: string; check_out: string; guests: number };

/** Each code, the Core section it comes from, and what it means. */
export const OFFER_RULE_TEXT: Record<OfferRuleCode, { section: string; text: string }> = {
  malformed_generated_at: { section: "§5, §6", text: "generated_at is missing or not a UTC date-time ending in Z" },
  malformed_valid_until: { section: "§5, §6", text: "valid_until is missing or not a UTC date-time ending in Z" },
  lifetime_not_positive: { section: "§5", text: "valid_until is not later than generated_at" },
  lifetime_too_long: { section: "§5", text: `valid_until is more than ${MAX_LIFETIME_SECONDS} seconds after generated_at` },
  generated_at_in_future: { section: "§6", text: `generated_at is more than ${CLOCK_SKEW_SECONDS} seconds later than the verifier's clock` },
  expired: { section: "§6", text: "valid_until has passed" },
  request_missing: { section: "§5", text: "the signed payload has no request" },
  invalid_check_in: { section: "§5", text: "request.check_in is not a date that exists" },
  invalid_check_out: { section: "§5", text: "request.check_out is not a date that exists" },
  check_out_not_after_check_in: { section: "§5", text: "request.check_out is not later than request.check_in" },
  check_in_in_past: { section: "§7", text: "request.check_in is earlier than the day before the UTC date" },
  invalid_language: { section: "§5", text: "request.language is not a language tag" },
  asked_stay_unknown: { section: "§7", text: "the stay asked for is not known to the verifier" },
  request_mismatch: { section: "§7", text: "the signed request is not the dates and guest count asked for" },
  clock_unusable: { section: "§6, §8", text: "the verifier's clock could not be read, so freshness and the dates cannot be judged" },
};

const DAY_MS = 86_400_000;

type Payload = Record<string, unknown> | null | undefined;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A YYYY-MM-DD date that exists in the calendar, as ms at UTC midnight; NaN otherwise. */
export function parseDate(value: unknown): number {
  const m = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return NaN;
  // setUTCFullYear, not Date.UTC: Date.UTC reads the years 0–99 as 1900–1999.
  const d = new Date(0);
  d.setUTCFullYear(+m[1], +m[2] - 1, +m[3]);
  const t = d.getTime();
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : NaN;
}

/** A UTC date-time in the schema's form (ending in Z) that exists, as ms; NaN otherwise. */
export function parseDateTime(value: unknown): number {
  const m =
    typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/.exec(value) : null;
  if (!m) return NaN;
  const d = new Date(0);
  d.setUTCFullYear(+m[1], +m[2] - 1, +m[3]);
  d.setUTCHours(+m[4], +m[5], +m[6], 0);
  const t = d.getTime();
  const exists =
    d.getUTCFullYear() === +m[1] &&
    d.getUTCMonth() === +m[2] - 1 &&
    d.getUTCDate() === +m[3] &&
    d.getUTCHours() === +m[4] &&
    d.getUTCMinutes() === +m[5] &&
    d.getUTCSeconds() === +m[6];
  return exists ? t + (m[7] ? Number(m[7]) * 1000 : 0) : NaN;
}

/** Whether `asked` names a stay: two date strings and an integer guest count of at least 1. */
export function isAskedStay(asked: unknown): asked is AskedStay {
  const a = record(asked);
  return Boolean(
    a &&
      typeof a.check_in === "string" &&
      typeof a.check_out === "string" &&
      Number.isInteger(a.guests) &&
      (a.guests as number) >= 1,
  );
}

/** The lifetime and clock reasons (§5, §6) for `payload` at `clock` (ms), in the vectors' order. */
export function lifetimeReasons(payload: Payload, clock: number): OfferRuleCode[] {
  const reasons: OfferRuleCode[] = [];
  const generated = parseDateTime(payload?.generated_at);
  const validUntil = parseDateTime(payload?.valid_until);
  if (Number.isNaN(generated)) reasons.push("malformed_generated_at");
  if (Number.isNaN(validUntil)) reasons.push("malformed_valid_until");
  if (!Number.isNaN(generated) && !Number.isNaN(validUntil)) {
    if (validUntil <= generated) reasons.push("lifetime_not_positive");
    else if (validUntil - generated > MAX_LIFETIME_SECONDS * 1000) reasons.push("lifetime_too_long");
  }
  if (!Number.isNaN(generated) && generated > clock + CLOCK_SKEW_SECONDS * 1000) {
    reasons.push("generated_at_in_future");
  }
  if (!Number.isNaN(validUntil) && validUntil <= clock) reasons.push("expired");
  return reasons;
}

/**
 * The stay reasons (§5, §7) for `payload.request` at `clock` (ms) against the
 * stay `asked` for, or null when the verifier does not know it; vectors' order.
 */
export function requestReasons(payload: Payload, clock: number, asked: AskedStay | null | undefined): OfferRuleCode[] {
  const reasons: OfferRuleCode[] = [];
  const request = record(payload?.request);
  if (!request) {
    reasons.push("request_missing");
    return reasons;
  }
  const checkIn = parseDate(request.check_in);
  const checkOut = parseDate(request.check_out);
  if (Number.isNaN(checkIn)) reasons.push("invalid_check_in");
  if (Number.isNaN(checkOut)) reasons.push("invalid_check_out");
  if (!Number.isNaN(checkIn) && !Number.isNaN(checkOut) && checkOut <= checkIn) {
    reasons.push("check_out_not_after_check_in");
  }
  // The local date anywhere is at most one day behind the UTC date.
  const dayBefore = Math.floor(clock / DAY_MS) * DAY_MS - DAY_MS;
  if (!Number.isNaN(checkIn) && checkIn < dayBefore) reasons.push("check_in_in_past");
  if ("language" in request && !(typeof request.language === "string" && LANGUAGE_TAG.test(request.language))) {
    reasons.push("invalid_language");
  }

  if (!isAskedStay(asked)) reasons.push("asked_stay_unknown");
  else if (
    request.check_in !== asked.check_in ||
    request.check_out !== asked.check_out ||
    request.guests !== asked.guests
  ) {
    reasons.push("request_mismatch");
  }
  return reasons;
}

/**
 * The reasons an offer is not quotable under the offer rules (§5, §6, §7); an
 * empty list when it meets them. `now` is the verifier's clock in ms (a clock
 * that cannot be read gives `clock_unusable`); `asked` is the stay the agent
 * asked for, or null when the verifier does not know it. Same result, same
 * order, as the VRP offer-rules vectors.
 */
export function checkOfferRules(payload: Payload, { now, asked }: { now: number; asked: AskedStay | null }): OfferRuleCode[] {
  // Every rule but the forms of the dates depends on the clock; without a
  // usable one nothing can be judged, and an empty list would read as a pass.
  if (typeof now !== "number" || !Number.isFinite(now)) return ["clock_unusable"];
  return [...lifetimeReasons(payload, now), ...requestReasons(payload, now, asked)];
}
