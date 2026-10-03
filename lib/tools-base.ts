/**
 * Shared tool execution — single source of truth for the 2 HemmaBo tools.
 *
 * The MCP transport (api/mcp.ts) is a thin wrapper that:
 *  1. Constructs its own Supabase clients (service-role + anon reader).
 *  2. Validates inputs (JSON-Schema).
 *  3. Delegates tool execution to `executeTool` below.
 *  4. Preserves its own error-handling semantics.
 *
 * This module does NOT catch errors — errors bubble up to the caller so the
 * transport can apply its own error-handling rules unchanged.
 *
 * MCP-06 invariant: bookings-dependent reads (checkAvailability, resolveQuote's
 * gap detection) MUST use the service-role client, because anon is denied on
 * the `bookings` table by RLS (`USING (false)`).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveQuote } from "./pricing.js";
import { checkAvailability, resolveEffectiveMinNights, type BufferNights } from "./availability.js";
import { DEFAULT_MIN_NIGHTS, nightsBetween, minNightsRefusalReason } from "./availability-core.js";
import {
  checkIcalImportFreshness,
  checkChannelMirrorState,
  calendarFreshnessUnavailablePayload,
  type CalendarFreshnessResult,
} from "./ical-freshness.js";
import { normalizeCountryToIso } from "./geo-directional-core.js";
import { resolveDirectionalTarget, propertyResolvesToRegion } from "./geo-directional-query.js";

export interface ToolClients {
  /** Service-role client — bypasses RLS. Required for bookings reads + all writes. */
  supabase: SupabaseClient;
  /** Anon client — subject to RLS. Used for published property/snapshot reads. */
  reader: SupabaseClient;
}

// ── Discovery signals: canonical, language-independent amenity / policy / suitability /
// setting flags surfaced on the search hit so an agent can match requests like dog-friendly,
// hot tub, crib, or hen party WITHOUT hitting a wall. TRUE flags only (compact, low-noise);
// free-text / keyword / embedding columns are deliberately excluded (over-matching/noise).
// Keys are canonical (English) — the agent renders them in the USER's language; never
// localised in the payload. These are host-declared discovery SIGNALS for matching — the
// signed verified-stay-offer and the property's own page remain authoritative.
const SIGNAL_GROUPS: Record<string, readonly string[]> = {
  amenities: [
    "wifi_included", "has_pool", "private_pool", "shared_pool", "has_sauna", "has_hot_tub",
    "spa_access", "gym_access", "has_fireplace", "has_workspace", "has_grill", "has_outdoor_dining",
    "has_terrace", "has_balcony", "has_garden", "has_parking", "has_ev_charging", "game_room",
    "cinema_room", "library", "wine_cellar", "baby_equipment", "high_chair", "crib_available",
    "playground", "breakfast_included", "coffee_tea_included", "linens_included", "towels_included",
    "bathrobes_included", "toiletries_included", "cleaning_included", "cleaning_service",
    "self_checkin", "wheelchair_accessible", "elevator_access", "ground_floor", "kayak_canoe",
    "bike_rental", "fishing_equipment", "ski_in_ski_out", "chef_available", "concierge_service",
    "airport_transfer", "firewood_included", "welcome_gift", "fruit_basket",
  ],
  policies: [
    "allows_pets", "allows_dogs", "allows_cats", "pet_friendly", "infants_allowed",
    "allows_parties", "allows_events", "smoking_allowed", "outdoor_smoking_only", "quiet_hours",
    "instant_booking", "long_term_stays",
  ],
  suitability: [
    "child_friendly", "senior_friendly", "bachelor_party_friendly", "bachelorette_party_friendly",
    "business_travel_ready", "remote_work_friendly", "allergy_friendly", "hypoallergenic",
    "eco_friendly", "solar_powered", "recycling_available",
  ],
  setting: [
    "has_sea_view", "has_lake_view", "has_mountain_view", "panoramic_view", "sunset_view",
    "stargazing", "near_beach", "near_ski_slope", "near_hiking_trails", "near_city_center",
    "near_public_transport", "near_golf_course", "near_national_park", "near_vineyard",
    "secluded_location", "waterfront", "private_beach", "coastal", "countryside",
    "forest_location", "mountain_area", "island_location", "lakeside", "horse_riding",
    "hunting_area", "fishing_area", "historic_building", "cultural_heritage", "design_interior",
  ],
};
const SIGNAL_ARRAY_FIELDS: Record<string, string> = {
  best_for_occasions: "bestForOccasions",
  target_audience: "targetAudience",
};
const SIGNAL_SELECT_COLUMNS = [
  "property_id",
  ...Object.values(SIGNAL_GROUPS).flat(),
  ...Object.keys(SIGNAL_ARRAY_FIELDS),
].join(",");

type PropertySignals = Record<string, string[]>;

/**
 * Display-format a canonical amenity token for human/agent-visible text
 * ("hot_tub" -> "Hot tub", "wifi" -> "WiFi"). Raw snake_case keys must never
 * render in guest-facing prose or the stay-offer widget (same rule as
 * smart-stays contracts/ts/amenity-labels.ts).
 */
const AMENITY_DISPLAY_SPECIAL: Record<string, string> = {
  wifi: "WiFi",
  bbq: "BBQ",
  tv: "TV",
  ev_charging: "EV charging",
};

/**
 * Real, previously-reviewed amenity-token translations, ported verbatim from
 * hemmabo-smart-stays/src/lib/amenityTranslations.ts (one vocabulary by test,
 * not by import — separate deployables, same pattern as TERM_LABELS in
 * hemmabo-mcp-server/lib/apps-widget-html.ts). 2026-07-26: found via a guest
 * recording where the widget's headline amenity row stayed English inside an
 * otherwise-Swedish card, because formatAmenityLabel never saw the requested
 * language. Tokens/languages absent here fall back to the English label
 * below — never a guessed/unreviewed translation.
 */
const AMENITY_LABEL_TRANSLATIONS: Record<string, Record<string, string>> = {
  wifi: { sv: "WiFi", de: "WLAN", fr: "WiFi", da: "WiFi", nl: "WiFi", no: "WiFi" },
  hot_tub: { sv: "Spabad", de: "Whirlpool", fr: "Jacuzzi", da: "Boblebad", nl: "Jacuzzi", no: "Boblebad" },
  fireplace: { sv: "Öppen spis", de: "Kamin", fr: "Cheminée", da: "Pejs", nl: "Open haard", no: "Peis" },
  garden: { sv: "Trädgård", de: "Garten", fr: "Jardin", da: "Have", nl: "Tuin", no: "Hage" },
  terrace: { sv: "Terrass", de: "Terrasse", fr: "Terrasse", da: "Terrasse", nl: "Terras", no: "Terrasse" },
  ev_charging: { sv: "Elbilsladdning", de: "E-Auto Ladestation", fr: "Borne de recharge", da: "Elbil-opladning", nl: "Elektrisch opladen", no: "Elbil-lading" },
  breakfast_included: { sv: "Frukost ingår", de: "Frühstück inklusive", fr: "Petit-déjeuner inclus", da: "Morgenmad inkluderet", nl: "Ontbijt inbegrepen", no: "Frokost inkludert" },
  air_conditioning: { sv: "Luftkonditionering", de: "Klimaanlage", fr: "Climatisation", da: "Aircondition", nl: "Airconditioning", no: "Klimaanlegg" },
  // grill/bbq are the same real-world amenity (CANONICAL_AMENITY_CLAIM_ALIASES
  // in smart-stays merges them) — both canonical keys share the bbq translation.
  grill: { sv: "Grill", de: "Grill", fr: "Barbecue", da: "Grill", nl: "BBQ", no: "Grill" },
  bbq: { sv: "Grill", de: "Grill", fr: "Barbecue", da: "Grill", nl: "BBQ", no: "Grill" },
};

export function formatAmenityLabel(token: string, language?: string): string {
  const t = String(token || "").trim();
  if (!t) return "";
  const lang = String(language || "").trim().toLowerCase().slice(0, 2);
  if (lang && lang !== "en") {
    const translated = AMENITY_LABEL_TRANSLATIONS[t.toLowerCase()]?.[lang];
    if (translated) return translated;
  }
  const special = AMENITY_DISPLAY_SPECIAL[t.toLowerCase()];
  if (special) return special;
  const words = t.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}


/**
 * Amenity signal column → canonical attested-claim token
 * (`property_attested_claims.claim_key`).
 *
 * The claims ledger is the WRITE-MASTER for amenity truth (one-truth program,
 * ADR hemmabo-smart-stays docs/DECISIONS/2026-07-02-claims-ledger-tri-state-attested).
 * The legacy boolean columns on property_detected_amenities are a derived mirror
 * that DRIFTS STALE — a host save can update the claim (`hot_tub` = affirmed) while
 * the boolean column (`has_hot_tub`) stays false, which made spa/hot-tub nodes
 * invisible to agent discovery even though the signed offer and property page showed
 * the amenity. So for any amenity that HAS a claim we trust the claim (affirmed = on,
 * negated = off) and only fall back to the boolean column when the node has NO claim
 * row for that token (un-migrated node). Amenity signals with no claim token stay
 * column-sourced. Mirrors AMENITY_FLAG_MAP + the backfill token map in smart-stays;
 * keep in sync when that vocabulary changes.
 */
const AMENITY_COLUMN_TO_CLAIM: Record<string, string> = {
  wifi_included: "wifi",
  has_pool: "pool",
  has_sauna: "sauna",
  has_hot_tub: "hot_tub",
  gym_access: "gym_access",
  has_fireplace: "fireplace",
  has_workspace: "workspace",
  has_grill: "grill",
  has_outdoor_dining: "outdoor_dining",
  has_terrace: "terrace",
  has_balcony: "balcony",
  has_garden: "garden",
  has_parking: "parking",
  has_ev_charging: "ev_charging",
  game_room: "game_room",
  cinema_room: "cinema_room",
  library: "library",
  high_chair: "high_chair",
  crib_available: "crib_available",
  playground: "playground",
  breakfast_included: "breakfast_included",
  linens_included: "linens_included",
  towels_included: "towels_included",
  cleaning_service: "cleaning_service",
  self_checkin: "self_checkin",
  wheelchair_accessible: "wheelchair_accessible",
  elevator_access: "elevator_access",
  ground_floor: "ground_floor",
  kayak_canoe: "kayak_canoe",
  bike_rental: "bike_rental",
  ski_in_ski_out: "ski_in_ski_out",
};

/** Per-property attested-claim state: which amenity tokens are affirmed, which are explicitly negated, and which are known (affirmed or negated). */
type PropertyClaims = { affirmed: Set<string>; negated: Set<string>; known: Set<string> };

/**
 * Guest-safety policy questions ("can I bring a cat?", "is smoking allowed?")
 * need the host's explicit NO, not just the absence of a yes — an agent that
 * only sees `allows_pets` will tell a cat owner "probably fine" when the host
 * has said no. These claim keys are emitted under `signals.policies_negated`
 * when the ledger marks them negated. Deliberately a small whitelist: matching
 * stays affirmed-only (CEO decision, one-truth program); negations are for
 * answering policy questions, not for filtering.
 */
const POLICY_NEGATION_CLAIM_KEYS = [
  "pets_dogs",
  "pets_cats",
  "smoking_indoor",
  "smoking_outdoor",
] as const;

/**
 * Amenity claims guests search for by name but that have NO boolean column on
 * property_detected_amenities (so the column-driven SIGNAL_GROUPS can never
 * emit them). Affirmed claims from this whitelist are appended to the
 * amenities signal group. The villa incident: blackout_curtains was live in
 * the node file since PR A but invisible to agent search. Keep the list
 * deliberately short — signals stay compact.
 */
const CLAIMS_ONLY_AMENITY_SIGNALS = [
  "blackout_curtains",
  "air_conditioning",
] as const;

/**
 * Resolve a single discovery signal to on/off. For the `amenities` group the
 * attested-claims ledger (write-master) wins over the stale boolean column: if the
 * node has ANY claim for the amenity, affirmed = on / negated = off; only when no
 * claim row exists (un-migrated node, or a column-only amenity with no claim token)
 * do we fall back to the legacy boolean column. Non-amenity groups are unchanged.
 */
function signalIsOn(
  group: string,
  col: string,
  row: Record<string, unknown>,
  claims: PropertyClaims | undefined,
): boolean {
  if (group === "amenities") {
    const token = AMENITY_COLUMN_TO_CLAIM[col];
    if (token && claims && claims.known.has(token)) {
      return claims.affirmed.has(token);
    }
  }
  return row[col] === true;
}

export function buildPropertySignals(
  row: Record<string, unknown> | undefined,
  claims?: PropertyClaims,
): PropertySignals | null {
  if (!row) return null;
  const out: PropertySignals = {};
  for (const [group, cols] of Object.entries(SIGNAL_GROUPS)) {
    let on = cols.filter((c) => signalIsOn(group, c, row, claims));
    if (group === "amenities") {
      // Emit the CANONICAL claim token (hot_tub), never the internal column
      // name (has_hot_tub) — signalsGuidance promises canonical keys, and
      // agents were quoting the raw column names to guests.
      const tokens = new Set(on.map((c) => AMENITY_COLUMN_TO_CLAIM[c] ?? c));
      // Claims-only amenities (no boolean column): affirmed ledger claims
      // like blackout_curtains join the group directly.
      if (claims) {
        for (const key of CLAIMS_ONLY_AMENITY_SIGNALS) {
          if (claims.affirmed.has(key)) tokens.add(key);
        }
      }
      on = Array.from(tokens);
    }
    if (group === "policies" && on.includes("outdoor_smoking_only")) {
      // outdoor_smoking_only IS the accurate smoking signal; emitting
      // smoking_allowed alongside it reads as a contradiction.
      on = on.filter((c) => c !== "smoking_allowed");
    }
    if (on.length > 0) out[group] = on;
  }
  if (claims) {
    // Explicit host NOs on policy questions. Sourced from the claims ledger
    // only — the boolean columns default to false and cannot distinguish
    // "host said no" from "never asked".
    const negated = POLICY_NEGATION_CLAIM_KEYS.filter((k) => claims.negated.has(k));
    if (negated.length > 0) out.policies_negated = negated;
  }
  for (const [col, label] of Object.entries(SIGNAL_ARRAY_FIELDS)) {
    const v = row[col];
    if (Array.isArray(v)) {
      const items = v.filter((x): x is string => typeof x === "string" && x.length > 0);
      if (items.length > 0) out[label] = items;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Fetch affirmed/known amenity-claim tokens per property from the write-master
 * (property_attested_claims). Failure degrades to an empty map so amenity signals
 * fall back to the legacy boolean columns — never breaks core search.
 */
async function fetchPropertyClaims(
  client: SupabaseClient,
  propertyIds: string[],
): Promise<Map<string, PropertyClaims>> {
  const byId = new Map<string, PropertyClaims>();
  if (propertyIds.length === 0) return byId;
  const { data, error } = await client
    .from("property_attested_claims")
    .select("property_id, claim_key, state")
    .in("property_id", propertyIds);
  if (error) {
    console.error("[search] property claims query error:", error.message);
    return byId;
  }
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const pid = typeof r.property_id === "string" ? r.property_id : null;
    const key = typeof r.claim_key === "string" ? r.claim_key : null;
    if (!pid || !key) continue;
    let entry = byId.get(pid);
    if (!entry) {
      entry = { affirmed: new Set<string>(), negated: new Set<string>(), known: new Set<string>() };
      byId.set(pid, entry);
    }
    entry.known.add(key);
    if (r.state === "affirmed") entry.affirmed.add(key);
    if (r.state === "negated") entry.negated.add(key);
  }
  return byId;
}

async function fetchPropertySignals(
  client: SupabaseClient,
  propertyIds: string[],
): Promise<Map<string, PropertySignals>> {
  const byId = new Map<string, PropertySignals>();
  if (propertyIds.length === 0) return byId;
  // Discovery signals are ADDITIVE. They must NEVER break core search: any failure
  // (query error, throw, schema/permission issue) degrades to "no signals" and search
  // continues. The error is logged so the root cause is diagnosable without an outage.
  try {
    // Amenity truth comes from the claims ledger (write-master); the detected-amenities
    // row supplies policy/suitability/setting signals + column-only amenities. Fetch both
    // in parallel — a claims-query failure degrades amenities to the legacy columns.
    const [detected, claimsById] = await Promise.all([
      client
        .from("property_detected_amenities")
        .select(SIGNAL_SELECT_COLUMNS)
        .in("property_id", propertyIds),
      fetchPropertyClaims(client, propertyIds),
    ]);
    const { data, error } = detected;
    if (error) {
      console.error("[search] property signals query error:", error.message);
      return byId;
    }
    if (!data) return byId;
    for (const row of data as unknown as Array<Record<string, unknown>>) {
      const pid = typeof row.property_id === "string" ? row.property_id : null;
      const signals = buildPropertySignals(row, pid ? claimsById.get(pid) : undefined);
      if (signals && pid) byId.set(pid, signals);
    }
  } catch (e) {
    console.error("[search] property signals threw:", e instanceof Error ? e.message : String(e));
  }
  return byId;
}

export type ToolResult = {
  content: { type: "text"; text: string }[];
  /** Machine-readable data shared with the model and Apps SDK widget. */
  structuredContent?: Record<string, unknown>;
  /** Widget-only metadata, when a transport or UI needs non-model context. */
  _meta?: Record<string, unknown>;
  /**
   * MCP-05: when true, the client must treat this as a tool-level failure
   * rather than a successful tool call whose `content` happens to describe
   * an error. Required by the MCP spec for tool errors; JSON-RPC protocol
   * errors go through a separate channel (`-32603`) and are not set here.
   */
  isError?: boolean;
};

const TOOL_NAME_ALIASES: Record<string, string> = {
  // Search tree
  "search.properties": "hemmabo_search_properties",
  "search.availability": "hemmabo_search_availability",
};

/**
 * Normalize an inbound tool name to the canonical snake_case form.
 *
 * Background (#59): The wire-level canonical names are snake_case
 * (`hemmabo_search_properties`) so they pass the claude.ai web frontend
 * regex `^[a-zA-Z0-9_-]{1,64}$`. The original dotted names
 * (`search.properties`) remain accepted as inbound aliases for backwards
 * compatibility — every dispatcher, validator, and auth gate funnels
 * names through this function so dotted callers continue to work.
 */
export function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns an error string if any of the provided date strings are not YYYY-MM-DD. */
export function validateDates(...dates: (string | undefined)[]): string | null {
  for (const d of dates) {
    if (d !== undefined && !ISO_DATE_RE.test(d)) {
      return `Invalid date format "${d}" — expected YYYY-MM-DD`;
    }
  }
  return null;
}

/** Returns an error string if checkOut is not strictly after checkIn. */
export function validateDateOrder(checkIn: string, checkOut: string): string | null {
  if (checkOut <= checkIn) {
    return `checkOut (${checkOut}) must be strictly after checkIn (${checkIn})`;
  }
  return null;
}

/**
 * Returns an error string listing any required keys whose value is `undefined`
 * or `null` in `args`. Prevents missing-arg values from reaching Supabase
 * filters as the literal string "undefined" (Postgres int parser rejects it
 * with `invalid input syntax for type integer: "undefined"`).
 *
 * Note: this does NOT validate types — JSON-Schema in TOOLS metadata is the
 * source of truth for shapes. This is a fail-fast guard against the most
 * common AI-agent error: omitting required fields entirely.
 */
export function validateRequiredArgs(
  args: Record<string, unknown>,
  required: readonly string[]
): string | null {
  const missing = required.filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length === 0) return null;
  return `Missing required argument(s): ${missing.join(", ")}`;
}

/** Wrap tool errors in the standard MCP tool-error envelope. */
function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

async function calendarFreshnessToolBlock(
  supabase: SupabaseClient,
  propertyId: string,
  checkIn: string,
  checkOut: string,
): Promise<{ block: ToolResult | null; freshness: CalendarFreshnessResult }> {
  const calendarFreshness = await checkIcalImportFreshness(supabase, propertyId, new Date());
  if (calendarFreshness.safe) return { block: null, freshness: calendarFreshness };
  return {
    freshness: calendarFreshness,
    block: {
      content: [{
        type: "text",
        text: JSON.stringify(
          calendarFreshnessUnavailablePayload(propertyId, checkIn, checkOut, calendarFreshness),
          null,
          2,
        ),
      }],
      isError: true,
    },
  };
}

type SearchPropertyRow = {
  id: string;
  name: string;
  domain: string | null;
  region: string | null;
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  max_guests: number | null;
  currency: string | null;
  property_type: string | null;
  direct_booking_discount: number | null;
  min_nights: number | null;
  buffer_nights_before: number | null;
  buffer_nights_after: number | null;
};

const LOCATION_ALIASES: Record<string, readonly string[]> = {
  se: ["sweden", "sverige"],
  sverige: ["sweden"],
  sweden: ["sverige"],
  skane: ["skane lan", "southern sweden", "south sweden", "sodra sverige"],
  "skane lan": ["skane"],
  "southern sweden": ["skane", "skane lan"],
  "south sweden": ["skane", "skane lan"],
  "sodra sverige": ["skane", "skane lan"],
  // ── Multilingual region aliases ──────────────────────────────────────────
  // So a German/Danish/French guest finds the same node as a Swedish one.
  // Extend per region: add localized names as keys pointing at the canonical
  // normalized region. Diacritics are already folded by normalizeLocationTerm
  // (ö→o, å→a, ü→u, ø→o), so "Schönen"→"schonen", "Südschweden"→"sudschweden".
  scania: ["skane", "skane lan"], // English / Latin
  scanie: ["skane", "skane lan"], // French
  skaane: ["skane", "skane lan"], // alt spelling
  schonen: ["skane", "skane lan"], // German (Schonen / Schönen)
  sudschweden: ["skane", "skane lan"], // German (Südschweden)
  sydsverige: ["skane", "skane lan"], // Danish / Norwegian
  // Country aliases (international guests searching by country name)
  schweden: ["sweden", "sverige"], // German
  suede: ["sweden", "sverige"], // French (Suède)
  zweden: ["sweden", "sverige"], // Dutch
  svezia: ["sweden", "sverige"], // Italian
  suecia: ["sweden", "sverige"], // Spanish
  kavlinge: [],
};

function repairCommonLocationMojibake(value: string): string {
  return value
    .replace(/\u00c3\u00a5/g, "\u00e5")
    .replace(/\u00c3\u00a4/g, "\u00e4")
    .replace(/\u00c3\u00b6/g, "\u00f6")
    .replace(/\u00c3\u2026/g, "\u00c5")
    .replace(/\u00c3\u0085/g, "\u00c5")
    .replace(/\u00c3\u201e/g, "\u00c4")
    .replace(/\u00c3\u0084/g, "\u00c4")
    .replace(/\u00c3\u2013/g, "\u00d6")
    .replace(/\u00c3\u0096/g, "\u00d6");
}

export function normalizeLocationTerm(value: string | null | undefined): string {
  return repairCommonLocationMojibake(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u00f8\u00f6]/g, "o")
    .replace(/[\u00e6\u00e4]/g, "a")
    .replace(/\u00e5/g, "a")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function expandLocationTerms(...values: Array<string | null | undefined>): string[] {
  const terms = new Set<string>();
  const visit = (value: string | null | undefined) => {
    const normalized = normalizeLocationTerm(value);
    if (!normalized || terms.has(normalized)) return;
    terms.add(normalized);
    for (const alias of LOCATION_ALIASES[normalized] ?? []) visit(alias);
  };
  for (const value of values) visit(value);
  return [...terms];
}

function fieldMatchesAnyTerm(value: string | null | undefined, terms: readonly string[]): boolean {
  const normalized = normalizeLocationTerm(value);
  return normalized.length > 0 && terms.some((term) => normalized.includes(term));
}

export function propertyMatchesLocation(
  property: Pick<SearchPropertyRow, "region" | "city" | "country"> &
    Partial<Pick<SearchPropertyRow, "latitude" | "longitude">>,
  region?: string,
  country?: string
): boolean {
  const searchable = [
    property.region,
    property.city,
    property.country,
    [property.city, property.region].filter(Boolean).join(" "),
    [property.region, property.country].filter(Boolean).join(" "),
  ];

  const regionTerms = expandLocationTerms(region);
  const countryTerms = expandLocationTerms(country);

  // A2 (ADR 0017): a directional destination phrase ("southern Spain",
  // "södra Spanien", "Sydsverige") resolves to ONE band from the vendored
  // canon and matches when the property's OWN country + coordinates sit in
  // that band. Additive — it never removes a name/alias match; a property
  // without a known country or finite coordinates never directional-matches
  // (omitted, not guessed). The region slot may borrow the country parameter
  // for its ISO ("södra" + country "Spanien"); a directional phrase in the
  // country slot pins its own country, so it may satisfy countryOk itself.
  const regionTarget = resolveDirectionalTarget(region, country);
  const countryTarget = resolveDirectionalTarget(country, undefined);
  const inRegionBand =
    regionTarget != null &&
    propertyResolvesToRegion(property.country, property.latitude, property.longitude, regionTarget.id);
  const inCountryBand =
    countryTarget != null &&
    propertyResolvesToRegion(property.country, property.latitude, property.longitude, countryTarget.id);

  const regionOk =
    regionTerms.length === 0 ||
    searchable.some((field) => fieldMatchesAnyTerm(field, regionTerms)) ||
    inRegionBand;
  // Free-text query country and free-text host country also compare as ISO
  // ("Spanien" matches a node storing "Sweden"-style free text "Spain").
  const isoQueryCountry = normalizeCountryToIso(country);
  const countryOk =
    countryTerms.length === 0 ||
    fieldMatchesAnyTerm(property.country, countryTerms) ||
    (isoQueryCountry != null && isoQueryCountry === normalizeCountryToIso(property.country)) ||
    inCountryBand;

  return regionOk && countryOk;
}

/** Upper bound on the one node round-trip an alternative window may cost. */
const NODE_NEXT_AVAILABLE_TIMEOUT_MS = 8_000;
const NODE_DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * The host node's own "next available" window for a closed stay
 * (VAKTHUND B, 2026-09-16). The platform MCP must never invent a different
 * "next free" than the node: live 2026-09-16 for 2026-10-18→19 / 6 guests the
 * node (/api/availability and the node MCP) answered host_blocked with
 * nextAvailable 2026-10-26→27 at 3 800 SEK, while www.hemmabo.com/mcp
 * offered three month-scan gaps starting 2026-10-01→03 at 8 600 SEK — a
 * second truth for the same property. So the alternative is now lifted
 * VERBATIM from the node's /api/availability for the SAME check-in,
 * check-out and guests: one window, the node's dates, the node's night
 * count, the node's total. No nextAvailable from the node ⇒ an empty list,
 * never a scanned window (findFreeWindowsInMonth no longer feeds this).
 *
 * Fail-closed on every edge: no domain, unreachable node, non-JSON, HTTP
 * error, timeout, or a node answer without nextAvailable ⇒ [].
 */
async function nodeNextAvailableAlternatives(
  supabase: SupabaseClient,
  propertyId: string,
  checkIn: string,
  checkOut: string,
  guests?: number,
): Promise<Array<Record<string, unknown>>> {
  const { data: prop, error } = await supabase
    .from("properties")
    .select("domain")
    .eq("id", propertyId)
    .maybeSingle();
  const rawDomain = typeof prop?.domain === "string" ? prop.domain : "";
  const domain = rawDomain.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (error || !NODE_DOMAIN_RE.test(domain)) return [];

  const params = new URLSearchParams({ checkIn, checkOut });
  if (typeof guests === "number") params.set("guests", String(guests));
  const url = `https://${domain}/api/availability?${params.toString()}`;

  let body: Record<string, unknown> | null = null;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(NODE_NEXT_AVAILABLE_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const parsed: unknown = await res.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return [];
  }
  if (!body || body.available !== false) return [];

  const next = body.nextAvailable;
  if (!next || typeof next !== "object") return [];
  const win = next as Record<string, unknown>;
  if (typeof win.checkIn !== "string" || typeof win.checkOut !== "string") return [];
  const nights =
    typeof win.nights === "number" && Number.isInteger(win.nights) && win.nights > 0
      ? win.nights
      : nightsBetween(win.checkIn, win.checkOut);
  if (!(nights > 0)) return [];

  const alternative: Record<string, unknown> = {
    checkIn: win.checkIn,
    checkOut: win.checkOut,
    nights,
    shorterThanRequested: false,
    available: true,
    source: "host_node_next_available",
    nodeDomain: domain,
  };
  const pricing = win.pricing;
  if (pricing && typeof pricing === "object") {
    const p = pricing as Record<string, unknown>;
    if (typeof p.totalPrice === "number" && Number.isFinite(p.totalPrice)) {
      const total = p.totalPrice;
      if (typeof p.currency === "string") alternative.currency = p.currency;
      alternative.publicTotal = total;
      alternative.federationTotal = total;
      Object.assign(alternative, directBookingPriceFields({ publicTotal: total, federationTotal: total }));
      alternative.packageApplied = null;
    }
  }
  return [alternative];
}

async function findAlternativeDates(
  supabase: SupabaseClient,
  propertyId: string,
  checkIn: string,
  checkOut: string,
  guests?: number,
  maxGuests?: number | null,
  _max = 3,
  _availabilityConfig?: { minNights?: number | null; buffers?: BufferNights | null }
): Promise<Array<Record<string, unknown>>> {
  if (
    typeof guests === "number" &&
    typeof maxGuests === "number" &&
    guests > maxGuests
  ) {
    return [];
  }
  // One truth: the node's own nextAvailable for the same stay tuple. Every
  // caller (search_properties, search_availability) follows this helper, so
  // no surface can offer a window the node itself would not.
  return nodeNextAvailableAlternatives(supabase, propertyId, checkIn, checkOut, guests);
}

// ── Direct host-source price fields ───────────────────────────────────────────

function directBookingPriceFields(quote: {
  publicTotal: number;
  federationTotal: number;
}): Record<string, number> {
  return {
    hostSourcePublicTotal: quote.publicTotal,
    directBookingTotal: quote.federationTotal,
  };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  clients: ToolClients
): Promise<ToolResult> {
  const { supabase, reader } = clients;
  const canonicalName = normalizeToolName(name);

  switch (canonicalName) {
    case "hemmabo_search_properties": {
      const reqErr = validateRequiredArgs(args, ["guests", "checkIn", "checkOut"]);
      if (reqErr) return toolError(reqErr);
      const { region, country, guests, checkIn, checkOut } = args as {
        region?: string; country?: string; guests: number; checkIn: string; checkOut: string;
      };
      const dateErr = validateDates(checkIn, checkOut);
      if (dateErr) return { content: [{ type: "text", text: JSON.stringify({ error: dateErr }) }], isError: true };
      const orderErr = validateDateOrder(checkIn, checkOut);
      if (orderErr) return { content: [{ type: "text", text: JSON.stringify({ error: orderErr }) }], isError: true };

      let query = reader
        .from("properties")
        .select("id, name, domain, region, city, country, latitude, longitude, max_guests, currency, property_type, direct_booking_discount, min_nights, buffer_nights_before, buffer_nights_after")
        .eq("published", true)
        .gte("max_guests", guests);

      const { data: properties, error } = await query;
      if (error) return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };

      const matchedProperties = (properties ?? []).filter((prop: SearchPropertyRow) =>
        propertyMatchesLocation(prop, region, country)
      );
      // Discovery signals: one prefetch for all matched properties (service-role — the flags
      // are public, shown on the property page, so they must reach anonymous agent calls too).
      const signalsById = await fetchPropertySignals(supabase, matchedProperties.map((p) => p.id));
      const results = [];
      const unavailableMatches = [];
      let anyMinNightsViolation = false;
      const requestedNights = nightsBetween(checkIn, checkOut);
      for (const prop of matchedProperties) {
        // The property row is already in hand — pass its turnaround buffer and
        // min-nights through instead of one extra properties read per property.
        const propBuffers: BufferNights = {
          before: prop.buffer_nights_before ?? 0,
          after: prop.buffer_nights_after ?? 0,
        };
        // Node parity (CEO order 2026-08-19): enforce the effective min-nights
        // BEFORE the calendar check, exactly like hemmabo_search_availability, and
        // surface a too-short stay as an unavailable entry carrying the NUMBER +
        // extend guidance. Never a silent drop — that left the agent to invent a
        // wrong reason ("dates are taken") for dates that were actually free.
        const effectiveMinNights = await resolveEffectiveMinNights(
          reader,
          prop.id,
          prop.min_nights ?? DEFAULT_MIN_NIGHTS,
          checkIn,
          new Date().toISOString().slice(0, 10),
        );
        if (requestedNights < effectiveMinNights) {
          anyMinNightsViolation = true;
          unavailableMatches.push({
            propertyId: prop.id,
            name: prop.name,
            domain: prop.domain,
            region: prop.region,
            city: prop.city,
            country: prop.country,
            maxGuests: prop.max_guests,
            propertyType: prop.property_type,
            available: false,
            reasonCode: "min_nights_violation",
            // Byte-identical reason with the node's /api/availability and
            // hemmabo_search_availability min_nights_violation branch — via the
            // vendored single source, never an inline template.
            reason: minNightsRefusalReason(effectiveMinNights, requestedNights),
            minimumNights: effectiveMinNights,
            alternativeDates: [],
          });
          continue;
        }
        // MCP-06: use service-role client so bookings table is visible to availability/gap checks
        const avail = await checkAvailability(
          supabase,
          prop.id,
          checkIn,
          checkOut,
          undefined,
          undefined,
          propBuffers,
        );
        if (!avail.available) {
          unavailableMatches.push({
            propertyId: prop.id,
            name: prop.name,
            domain: prop.domain,
            region: prop.region,
            city: prop.city,
            country: prop.country,
            maxGuests: prop.max_guests,
            propertyType: prop.property_type,
            available: false,
            reason: avail.reason ?? "Requested dates are not available",
            alternativeDates: await findAlternativeDates(
              supabase,
              prop.id,
              checkIn,
              checkOut,
              guests,
              prop.max_guests,
              3,
              { minNights: prop.min_nights, buffers: propBuffers },
            ),
          });
          continue;
        }
        const quote = await resolveQuote(supabase, prop.id, checkIn, checkOut, guests);
        if ("error" in quote) continue;
        results.push({
          propertyId: prop.id, name: prop.name, domain: prop.domain,
          // The node's own booking URL, derived exactly as hemmabo-smart-stays
          // api/search-properties.ts does: https:// + the property's domain,
          // null when the property has no domain.
          booking_url: prop.domain ? `https://${String(prop.domain).trim().toLowerCase()}` : null,
          region: prop.region, city: prop.city, country: prop.country,
          maxGuests: prop.max_guests, propertyType: prop.property_type,
          minNights: prop.min_nights ?? DEFAULT_MIN_NIGHTS,
          currency: quote.currency, nights: quote.nights,
          publicTotal: quote.publicTotal,
          ...directBookingPriceFields(quote),
          federationTotal: quote.federationTotal,
          packageApplied: quote.packageApplied, available: true,
          ...(signalsById.get(prop.id) ? { signals: signalsById.get(prop.id) } : {}),
        });
      }

      // A2 (ADR 0017): deterministic, alphabetical output — match/no-match
      // plus name order, never a ranking. Codepoint compare on lowercased
      // name (tiebreaks: domain, then propertyId) is stable across runs,
      // databases, and locales.
      const alphabetical = (
        a: { name: string | null; domain: string | null; propertyId: string },
        b: { name: string | null; domain: string | null; propertyId: string },
      ): number => {
        const an = (a.name ?? "").toLowerCase();
        const bn = (b.name ?? "").toLowerCase();
        if (an !== bn) return an < bn ? -1 : 1;
        const ad = (a.domain ?? "").toLowerCase();
        const bd = (b.domain ?? "").toLowerCase();
        if (ad !== bd) return ad < bd ? -1 : 1;
        return a.propertyId < b.propertyId ? -1 : a.propertyId > b.propertyId ? 1 : 0;
      };
      results.sort(alphabetical);
      unavailableMatches.sort(alphabetical);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            checkIn,
            checkOut,
            guests,
            properties: results,
            unavailableMatches,
            priceFieldGuidance: {
              preferredTotalField: "directBookingTotal",
              preferredPublicTotalField: "hostSourcePublicTotal",
              legacyTotalField: "federationTotal",
              userFacingRule: "Describe directBookingTotal as the direct host-source total. Do not present discounts, savings, percentage comparisons, HemmaBo platform prices, federation prices, OTA prices, marketplace prices, or comparison prices.",
            },
            agentGuidance: results.length > 0
              ? "Each result is a matching host domain; return them as given and do not rank them or compare their prices. When a host domain is known, call get_verified_stay_offer with the same check-in, check-out, and guest count so the client can render the verified stay offer widget. For pricing, use directBookingTotal as the direct host-source total and hostSourcePublicTotal only as source context. Do not present discounts, savings, percentage comparisons, HemmaBo platform prices, OTA comparisons, or marketplace discounts. Each result carries booking_url on the host's own domain — the signed direct host-domain booking URL comes from the verified offer. If the guest wants to book, route only to that URL; do not collect contact details or start checkout in chat."
              : anyMinNightsViolation
                ? "The requested stay is shorter than the property's minimum. Read minimumNights on each unavailable match and tell the guest that exact figure, then suggest extending the stay to meet it. Do NOT say the dates are unavailable and do NOT ask the guest to change month or guest count — the dates may well be free."
                : unavailableMatches.some((p) => Array.isArray(p.alternativeDates) && p.alternativeDates.length > 0)
                  ? "Requested dates are unavailable. Offer the alternativeDates for the matched property instead of ending the conversation."
                  : matchedProperties.length > 0
                    ? "Matching properties were found, but the requested dates are unavailable and the host node offered no next available window. Ask whether the guest can change month or guest count."
                    : "No published property matched the location and capacity. Ask for a broader destination or fewer guests.",
            signalsGuidance: "Each property's `signals` are host-declared, language-independent discovery flags (amenities / policies / suitability / setting, plus bestForOccasions / targetAudience) for matching requests like dog-friendly, hot tub, crib, or hen party. They are canonical keys — ALWAYS render them as translated human labels in the user's language and NEVER show the raw keys, parenthesized identifiers, or internal field names to the user. `policies_negated` lists the host's EXPLICIT NOs (e.g. pets_cats there means cats are not allowed) — relay those as a clear, friendly no. For anything absent from both lists the answer is UNKNOWN, not 'no': say something like 'There is no verified information about that — if it matters to you, ask the host before booking', never machine-speak like 'not flagged in the data'. Treat flags as match signals, not verified guarantees: the signed verified-stay-offer and the property's own page are authoritative. Never describe internal data-layer differences (e.g. signals vs the signed offer's amenity list) to the guest. Tone: warm and plain — say the stay 'matches your wishes', never call it a 'perfect match', and never mention commissions, fee percentages, or 'no hidden fees'; simply say booking and payment are made directly with the host.",
          }, null, 2),
        }],
      };
    }

    case "hemmabo_search_availability": {
      const reqErr = validateRequiredArgs(args, ["propertyId", "checkIn", "checkOut"]);
      if (reqErr) return toolError(reqErr);
      const { propertyId, checkIn, checkOut, guests } = args as { propertyId: string; checkIn: string; checkOut: string; guests?: number };
      const dateErr = validateDates(checkIn, checkOut);
      if (dateErr) return { content: [{ type: "text", text: JSON.stringify({ error: dateErr }) }], isError: true };
      const orderErr = validateDateOrder(checkIn, checkOut);
      if (orderErr) return { content: [{ type: "text", text: JSON.stringify({ error: orderErr }) }], isError: true };

      // Node parity (CEO order 2026-08-19): search enforces the same per-node
      // rules as the node's /api/availability — capacity first, then
      // min-nights — so search can never say available where the node
      // answers min_nights_violation. One unconditional properties read;
      // min_nights is per node (NOT NULL since migration 20260819120000),
      // DEFAULT_MIN_NIGHTS is the platform-level defensive fallback only.
      const { data: property, error: propErr } = await reader
        .from("properties")
        .select("max_guests, min_nights")
        .eq("id", propertyId)
        .single();
      if (propErr || !property) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Property not found" }) }],
          isError: true,
        };
      }
      const maxGuests: number | null = property.max_guests ?? null;
      if (typeof guests === "number") {
        if (typeof maxGuests === "number" && guests > maxGuests) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                propertyId,
                checkIn,
                checkOut,
                guests,
                maxGuests,
                available: false,
                reasonCode: "guests_exceed_max",
                reason: `Property accommodates maximum ${maxGuests} guests`,
                alternativeDates: [],
                agentGuidance: "The requested guest count exceeds this property's capacity. Do not offer alternative dates for this property; ask for fewer guests or search for a larger property.",
              }, null, 2),
            }],
          };
        }
      }

      const requestedNights = nightsBetween(checkIn, checkOut);
      // Effective minimum: the base folded with the host's smart-pricing
      // modifiers (gap-fill / last-minute) via the vendored shared truth (PR-A3),
      // so MCP search refuses on exactly the floor the node's /api/availability,
      // the guest-UI and the Deno agent path enforce. Fail-safe to the base.
      const minNights: number = await resolveEffectiveMinNights(
        reader,
        propertyId,
        property.min_nights ?? DEFAULT_MIN_NIGHTS,
        checkIn,
        new Date().toISOString().slice(0, 10),
      );
      if (requestedNights < minNights) {
        // Byte-identical reason with the node's /api/availability
        // min_nights_violation branch — MCP and node must answer the same.
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              propertyId,
              checkIn,
              checkOut,
              ...(typeof guests === "number" ? { guests } : {}),
              available: false,
              reasonCode: "min_nights_violation",
              reason: minNightsRefusalReason(minNights, requestedNights),
              minimumNights: minNights,
              alternativeDates: [],
              agentGuidance: `This property requires at least ${minNights} nights. Extend the stay to ${minNights} or more nights instead of offering other dates.`,
            }, null, 2),
          }],
        };
      }

      // MCP-06: use service-role client so bookings table is visible to availability checks
      const result = await checkAvailability(supabase, propertyId, checkIn, checkOut);
      if (!result.available) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...result,
              guests,
              maxGuests,
              alternativeDates: await findAlternativeDates(
                supabase,
                propertyId,
                checkIn,
                checkOut,
                guests,
                maxGuests,
              ),
              agentGuidance: "Requested dates are unavailable. If alternativeDates is non-empty, offer those date windows before ending the conversation.",
            }, null, 2),
          }],
        };
      }
      const { block: calendarBlock, freshness: calendarFreshness } =
        await calendarFreshnessToolBlock(supabase, propertyId, checkIn, checkOut);
      if (calendarBlock) return calendarBlock;
      // OQ-3 (ADR §6 alt 1): both sync directions as FIRST-CLASS declared
      // fields — inbound freshness (the gate above) and the outbound
      // channel-mirror heartbeat. channel_mirror is informational only and
      // never affects `available` (the node is the source of truth).
      const channelMirror = await checkChannelMirrorState(supabase, propertyId, new Date());
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            { ...result, calendar_freshness: calendarFreshness, channel_mirror: channelMirror },
            null,
            2,
          ),
        }],
      };
    }

    default:
      return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
  }
}
