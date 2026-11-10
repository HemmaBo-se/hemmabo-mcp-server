/**
 * Required amenities in search: match / no match, never a ranking.
 *
 * A guest who asks for "a stay with a hot tub" has stated a requirement, not
 * a preference. The match is decided by the host's own declaration in the
 * attested-claims ledger (`property_attested_claims`, write-master for
 * amenity truth): a node matches a required amenity only when its claim for
 * that amenity is `affirmed`. `negated` (the host said no) and `unknown`
 * (no claim row: the host never answered) are not a confirmed yes, so the
 * node is not a match. The legacy boolean mirror
 * (`property_detected_amenities.has_*`) is never consulted for a requirement:
 * it drifts stale (villaakerlyckan.se 2026-11-10: `has_hot_tub` false while
 * the claim is affirmed).
 *
 * The claim-key vocabulary and the alias map mirror hemmabo-smart-stays
 * contracts/ts/property-claims-core.ts (CANONICAL_AMENITY_CLAIM_ALIASES,
 * claimState); keep them in step when that vocabulary changes.
 */

export type ClaimState = "affirmed" | "negated" | "unknown";

/** Verbatim from smart-stays contracts/ts/property-claims-core.ts. */
const CANONICAL_AMENITY_CLAIM_ALIASES: Readonly<Record<string, string>> = {
  bbq: "grill",
  beach_access: "near_beach",
  bicycles: "bike_rental",
  books: "library",
  breakfast: "breakfast_included",
  cinema: "cinema_room",
  cleaning_available: "cleaning_service",
  crib: "crib_available",
  elevator: "elevator_access",
  free_parking_onsite: "parking",
  game_console: "game_room",
  gym: "gym_access",
  kayak: "kayak_canoe",
  lake_access: "lakeside",
  outdoor_playground: "playground",
  single_level: "ground_floor",
  ski_in_out: "ski_in_ski_out",
};

/**
 * Discovery-signal column names agents have been shown (`has_hot_tub`,
 * `wifi_included`) and plain-language spellings of the same amenity. These
 * only name an amenity; they never decide a state.
 */
const REQUIREMENT_SPELLINGS: Readonly<Record<string, string>> = {
  has_hot_tub: "hot_tub",
  hottub: "hot_tub",
  jacuzzi: "hot_tub",
  whirlpool: "hot_tub",
  has_sauna: "sauna",
  has_pool: "pool",
  swimming_pool: "pool",
  wifi_included: "wifi",
  has_fireplace: "fireplace",
  has_workspace: "workspace",
  has_grill: "grill",
  has_outdoor_dining: "outdoor_dining",
  has_terrace: "terrace",
  has_balcony: "balcony",
  has_garden: "garden",
  has_parking: "parking",
  has_ev_charging: "ev_charging",
};

const CLAIM_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

/** Canonical form of a ledger claim key (identity for non-aliased keys). */
export function canonicalAmenityClaimKey(key: string): string {
  return CANONICAL_AMENITY_CLAIM_ALIASES[key] ?? key;
}

/** The canonical claim key a requirement names, or null when it names nothing usable. */
export function normalizeAmenityRequirement(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const key = input
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!CLAIM_KEY_RE.test(key)) return null;
  const spelled = REQUIREMENT_SPELLINGS[key] ?? key;
  return CANONICAL_AMENITY_CLAIM_ALIASES[spelled] ?? spelled;
}

export type AmenityRequirementParse =
  | { ok: true; required: string[] }
  | { ok: false; error: string };

/**
 * Parse the optional `amenities` argument: absent ⇒ no requirement (the
 * search behaves exactly as before). Present ⇒ an array of names, each
 * normalized to one canonical claim key, de-duplicated and sorted, so the
 * same requirement always yields the same key set.
 */
export function parseAmenityRequirements(value: unknown): AmenityRequirementParse {
  if (value === undefined || value === null) return { ok: true, required: [] };
  if (!Array.isArray(value)) {
    return { ok: false, error: "amenities must be an array of amenity names, e.g. [\"hot_tub\"]." };
  }
  const keys = new Set<string>();
  for (const item of value) {
    const key = normalizeAmenityRequirement(item);
    if (!key) {
      return { ok: false, error: `amenities contains a value that is not an amenity name: ${JSON.stringify(item)}.` };
    }
    keys.add(key);
  }
  return { ok: true, required: Array.from(keys).sort() };
}

/** One node's host-declared claims, as read from the ledger. */
export type NodeClaims = { affirmed: ReadonlySet<string>; negated: ReadonlySet<string> };

/** Tri-state lookup: no claim row ⇒ unknown, never coerced to yes or no. */
export function amenityClaimState(claims: NodeClaims | undefined, key: string): ClaimState {
  if (!claims) return "unknown";
  if (claims.affirmed.has(key)) return "affirmed";
  if (claims.negated.has(key)) return "negated";
  return "unknown";
}

/** The requested keys and the node's state for each: the facts the model needs. */
export function requiredAmenityFacts(
  claims: NodeClaims | undefined,
  required: readonly string[],
): Record<string, ClaimState> {
  const out: Record<string, ClaimState> = {};
  for (const key of required) out[key] = amenityClaimState(claims, key);
  return out;
}

/** Match: every required amenity is affirmed by the host. Nothing else counts. */
export function meetsAmenityRequirements(
  claims: NodeClaims | undefined,
  required: readonly string[],
): boolean {
  return required.every((key) => amenityClaimState(claims, key) === "affirmed");
}
