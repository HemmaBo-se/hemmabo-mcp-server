/**
 * A2 — the federation search's directional-query resolver (ADR 0017).
 *
 * Translates a guest's directional destination phrase ("southern Spain",
 * "södra Spanien", "Sydsverige", "Sur de España") into ONE directional band
 * from the vendored canon (lib/geo-directional-core.ts), so search can match
 * it against each node's OWN coordinates. Deterministic match/no-match:
 * the same phrase always resolves to the same band or to null — never a
 * guess, never a score, never a ranking.
 *
 * THIS FILE'S TABLES ARE DATA, NOT HAND-MAINTAINED LOGIC (same doctrine as
 * the canon): query-language coverage grows by ADDING TERM ROWS, never by
 * editing the parsing rules. Country aliases are read ONLY from the vendored
 * canon — one source of truth; a country spelling the canon lacks (e.g. the
 * German "Italien") is a canon gap to fix in hemmabo-smart-stays first and
 * re-vendor, never a local patch here.
 *
 * Red line (unchanged): resolving "southern Spain" to the es_south band and
 * filtering nodes whose own coordinates sit in it is deterministic matchable
 * context — not a portal, not curation. Results stay match/no-match and are
 * ordered alphabetically by the caller.
 */

import {
  COUNTRY_ALIASES,
  DIRECTIONAL_REGIONS,
  computeDirectional,
  normalizeCountryToIso,
  type DirectionalRegionRow,
} from "./geo-directional-core.js";

// ── Direction vocabulary (DATA — folded form, see foldTerm) ────────────────
// Folded with the same rules as the search layer's location folding
// (lowercase, strip diacritics, ø/ö→o, æ/ä→a, å→a): "södra"→"sodra",
// "sør"→"sor", "süd"→"sud", "etelä"→"etela". One row per guest language where
// the directional term is standard and unambiguous; extend per language by
// adding rows. Terms are matched per token and as compound prefixes
// ("sydsverige" = "syd" + "sverige").
const DIRECTION_TERMS: Record<"south" | "central" | "north", readonly string[]> = {
  south: [
    "southern", "south", // en
    "sodra", "soder", "syd", // sv (+ shared Scandinavian "syd")
    "sydlige", "sydlig", "sor", "sorlige", // da / nb
    "sud", "suden", "sudlich", // de (Süd / Süden / südlich) + fr/it "sud"
    "sur", // es
    "meridionale", // it
    "zuid", "zuidelijk", // nl
    "etela", "etelainen", // fi (Etelä-)
    "poludnie", "poludniowa", "poludniowe", // pl
  ],
  central: [
    "central", "centrala", "mellersta", // en / sv
    "midt", "midtre", // nb / da
    "mitte", "mittel", // de (Mitte / Mittel-)
    "centre", "centrale", "centro", // fr / it / es
    "midden", // nl
    "keski", // fi (Keski-)
    "srodkowa", "srodkowe", // pl (środkowa)
  ],
  north: [
    "northern", "north", // en
    "norra", "norr", // sv
    "nord", "nordlige", "nordlig", // da / nb / de / fr / it share "nord"
    "norte", // es
    "settentrionale", // it
    "noord", "noordelijk", // nl
    "pohjois", "pohjoinen", // fi (Pohjois-)
    "polnoc", "polnocna", "polnocne", // pl (północna)
  ],
};

type Direction = keyof typeof DIRECTION_TERMS;

/**
 * Fold a free-text term for matching: lowercase, strip combining diacritics,
 * map the Nordic letters that NFD does not decompose (ø, æ; ö/ä/å decompose),
 * collapse everything non-alphanumeric to single spaces. Mirrors the search
 * layer's location normalization so both layers agree on what "equal" means.
 */
export function foldTerm(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[øö]/g, "o")
    .replace(/[æä]/g, "a")
    .replace(/å/g, "a")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Folded country-alias keys from the canon, usable as in-phrase tokens.
// Two-letter ISO keys ("se", "no", "it", …) are excluded here — as free
// tokens inside a phrase they collide with ordinary words ("it", "no");
// they still work when the phrase IS the country (normalizeCountryToIso).
const COUNTRY_TOKENS: ReadonlyMap<string, string> = new Map(
  Object.entries(COUNTRY_ALIASES)
    .map(([alias, iso]) => [foldTerm(alias), iso] as const)
    .filter(([alias]) => alias.length >= 3),
);

const DIRECTION_BY_TERM: ReadonlyMap<string, Direction> = new Map(
  (Object.entries(DIRECTION_TERMS) as Array<[Direction, readonly string[]]>).flatMap(
    ([direction, terms]) => terms.map((t) => [t, direction] as const),
  ),
);

// Longest-first for deterministic compound-prefix splitting ("sydsverige").
const DIRECTION_TERMS_LONGEST_FIRST: readonly string[] = [...DIRECTION_BY_TERM.keys()].sort(
  (a, b) => b.length - a.length || a.localeCompare(b),
);

// Folded full labels ("southern spain", "sur de espana", "sodra sverige") →
// region row. Built once from the canon; labels are already per-language.
const REGION_BY_FOLDED_LABEL: ReadonlyMap<string, DirectionalRegionRow> = new Map(
  DIRECTIONAL_REGIONS.flatMap((row) =>
    Object.values(row.label).map((label) => [foldTerm(label), row] as const),
  ),
);

const REGION_BY_ID: ReadonlyMap<string, DirectionalRegionRow> = new Map(
  DIRECTIONAL_REGIONS.map((row) => [row.id, row]),
);

function regionFor(iso: string, direction: Direction): DirectionalRegionRow | null {
  // Band ids follow `${iso}_${direction}` in the canon; a country without
  // that band (e.g. Spain has no es_central) resolves to null — an honest
  // no-match, never an approximation.
  return REGION_BY_ID.get(`${iso.toLowerCase()}_${direction}`) ?? null;
}

/**
 * Resolve a guest's region/country phrasing to ONE directional band, or null.
 *
 * Deterministic paths, in order:
 *   1. The region phrase equals a band label in any seeded language
 *      ("southern spain", "sur de españa", "södra sverige").
 *   2. The region phrase carries a direction term and a country alias as
 *      tokens or as one compound token ("södra spanien", "sydsverige",
 *      "süddeutschland"); the country may instead come from the separate
 *      country parameter ("södra" + country "Spanien").
 * A direction with no resolvable country yields null — never a guess.
 */
export function resolveDirectionalTarget(
  regionPhrase: string | null | undefined,
  countryPhrase: string | null | undefined,
): DirectionalRegionRow | null {
  const folded = foldTerm(regionPhrase);
  if (!folded) return null;

  const byLabel = REGION_BY_FOLDED_LABEL.get(folded);
  if (byLabel) return byLabel;

  let direction: Direction | null = null;
  let iso: string | null = null;

  for (const token of folded.split(" ")) {
    if (direction == null) {
      const d = DIRECTION_BY_TERM.get(token);
      if (d) {
        direction = d;
        continue;
      }
      // Compound token: direction prefix + country alias ("sydsverige").
      for (const term of DIRECTION_TERMS_LONGEST_FIRST) {
        if (token.length > term.length && token.startsWith(term)) {
          const restIso = COUNTRY_TOKENS.get(token.slice(term.length)) ?? null;
          if (restIso) {
            direction = DIRECTION_BY_TERM.get(term) ?? null;
            iso = iso ?? restIso;
            break;
          }
        }
      }
      if (direction != null) continue;
    }
    if (iso == null) {
      iso = COUNTRY_TOKENS.get(token) ?? null;
    }
  }

  if (direction == null) return null;
  if (iso == null) iso = normalizeCountryToIso(countryPhrase);
  if (iso == null) return null;

  return regionFor(iso, direction);
}

/**
 * Does this node's OWN data place it in the given band? False whenever the
 * node lacks a known country or finite coordinates — omitted, never guessed.
 */
export function propertyResolvesToRegion(
  country: unknown,
  lat: unknown,
  lon: unknown,
  regionId: string,
): boolean {
  const d = computeDirectional(country, lat, lon);
  return d != null && d.regions.some((r) => r.id === regionId);
}
