/**
 * Geo-directional core — VENDORED mirror (A2, ADR 0017).
 *
 * Faithful TypeScript port of the host-node canon in hemmabo-smart-stays:
 *   - `api/_lib/geo-directional-regions.js`  (the DATA: bands + country aliases)
 *   - `api/_lib/geo-directional.js`          (the algorithm: computeDirectional)
 *
 * Same law as lib/availability-core.ts / lib/pricing-core.ts (ADR 0015): any
 * change here MUST be mirrored in the smart-stays source in the same PR-pair,
 * and vice versa. Parity is anchored by the fixtures in
 * `src/geo-directional-a2.contract.test.ts`, which mirror smart-stays
 * `tests/contracts/geo-directional.contract.test.ts` (villa → se_south,
 * Öresund country guard, global anchors, determinism, banned-words scan).
 *
 * Doctrine / red line (identical to the source): a directional band is a
 * factual statement about a node's OWN coordinates — matchable context for
 * intents like "a stay in southern Sweden". It NEVER ranks, never compares
 * properties, never curates a "best of" a region. Coverage grows by ADDING
 * DATA ROWS, never by editing the algorithm. Missing/unknown country ⇒ null —
 * we never guess a country from coordinates (the country guard is what
 * disambiguates nodes near a border/strait, e.g. Öresund).
 */

export type DirectionalRegionRow = {
  country: string;
  id: string;
  latMin?: number;
  latMax?: number;
  lonMin?: number;
  lonMax?: number;
  label: Record<string, string>;
};

export type DirectionalResult = {
  own_location_only: true;
  method: string;
  regions: Array<{ id: string; label: Record<string, string> }>;
};

// Country alias → ISO-3166-1 alpha-2. `node.country` is free-text host input
// ("Sweden", "Sverige", "SE"), so we normalize before matching and the same
// band fires regardless of how the host spelled the country. Keys are
// lower-cased; keep the set aligned with the seeded countries below.
export const COUNTRY_ALIASES: Record<string, string> = {
  sweden: "SE", sverige: "SE", se: "SE", swe: "SE",
  norway: "NO", norge: "NO", no: "NO", nor: "NO",
  italy: "IT", italia: "IT", it: "IT", ita: "IT",
  france: "FR", frankrike: "FR", fr: "FR", fra: "FR",
  germany: "DE", deutschland: "DE", tyskland: "DE", de: "DE", deu: "DE",
  spain: "ES", "españa": "ES", espana: "ES", spanien: "ES", es: "ES", esp: "ES",
};

// Entry shape: { country (ISO a2), id, latMin?, latMax?, lonMin?, lonMax?, label }
// A row matches when country matches AND every provided bound holds:
//   latMin <= lat < latMax  (bounds omitted ⇒ unconstrained on that edge)
// label carries `en` (authoritative, low error surface) plus the country's own
// language where the directional term is standard and certain.
export const DIRECTIONAL_REGIONS: readonly DirectionalRegionRow[] = [
  // — Sweden (live market) —
  { country: "SE", id: "se_south", latMax: 58.5, label: { en: "Southern Sweden", sv: "Södra Sverige" } },
  { country: "SE", id: "se_central", latMin: 58.5, latMax: 61.0, label: { en: "Central Sweden", sv: "Mellersta Sverige" } },
  { country: "SE", id: "se_north", latMin: 61.0, label: { en: "Northern Sweden", sv: "Norra Sverige" } },

  // — Norway —
  { country: "NO", id: "no_south", latMax: 60.0, label: { en: "Southern Norway", nb: "Sør-Norge" } },
  { country: "NO", id: "no_central", latMin: 60.0, latMax: 65.0, label: { en: "Central Norway", nb: "Midt-Norge" } },
  { country: "NO", id: "no_north", latMin: 65.0, label: { en: "Northern Norway", nb: "Nord-Norge" } },

  // — Italy —
  { country: "IT", id: "it_south", latMax: 41.5, label: { en: "Southern Italy", it: "Italia meridionale" } },
  { country: "IT", id: "it_central", latMin: 41.5, latMax: 44.0, label: { en: "Central Italy", it: "Italia centrale" } },
  { country: "IT", id: "it_north", latMin: 44.0, label: { en: "Northern Italy", it: "Italia settentrionale" } },

  // — France (mainland) —
  { country: "FR", id: "fr_south", latMax: 46.0, label: { en: "Southern France", fr: "Sud de la France" } },
  { country: "FR", id: "fr_north", latMin: 46.0, label: { en: "Northern France", fr: "Nord de la France" } },

  // — Germany —
  { country: "DE", id: "de_south", latMax: 50.5, label: { en: "Southern Germany", de: "Süddeutschland" } },
  { country: "DE", id: "de_north", latMin: 50.5, label: { en: "Northern Germany", de: "Norddeutschland" } },

  // — Spain (mainland) —
  { country: "ES", id: "es_south", latMax: 40.4, label: { en: "Southern Spain", es: "Sur de España" } },
  { country: "ES", id: "es_north", latMin: 40.4, label: { en: "Northern Spain", es: "Norte de España" } },
];

/**
 * Normalize free-text `country` (host input: "Sweden" / "Sverige" / "SE") to an
 * ISO-3166-1 alpha-2 code we have bands for, or null when unknown.
 */
export function normalizeCountryToIso(country: unknown): string | null {
  if (typeof country !== "string") return null;
  const key = country.trim().toLowerCase();
  if (!key) return null;
  return COUNTRY_ALIASES[key] || null;
}

/**
 * Compute the node's own directional macro-region(s). Returns an own-location
 * block mirroring the node's computeNearby(), or null when the country is
 * unknown or the coordinates are non-finite.
 */
export function computeDirectional(
  country: unknown,
  lat: unknown,
  lon: unknown,
  regions: readonly DirectionalRegionRow[] = DIRECTIONAL_REGIONS,
): DirectionalResult | null {
  const iso = normalizeCountryToIso(country);
  if (!iso) return null;

  const latN = Number(lat);
  const lonN = Number(lon);
  if (!Number.isFinite(latN) || !Number.isFinite(lonN)) return null;

  const matched = regions
    .filter((r) => r.country === iso)
    .filter(
      (r) =>
        (r.latMin == null || latN >= r.latMin) &&
        (r.latMax == null || latN < r.latMax) &&
        (r.lonMin == null || lonN >= r.lonMin) &&
        (r.lonMax == null || lonN < r.lonMax),
    )
    // Stable, id-sorted order — deterministic output, never a ranking.
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => ({ id: r.id, label: r.label }));

  if (matched.length === 0) return null;

  return {
    own_location_only: true,
    method:
      "approximate directional band from the node's own coordinates, scoped by ISO country; deterministic match/no-match — never a ranking or comparison",
    regions: matched,
  };
}
