# ADR 0017: A2 — directional search resolver (deterministic, alphabetical, no-score)

- Status: Accepted (CEO "KÖR A2", 2026-08-26)
- Date: 2026-08-26

## Context

A1 (smart-stays ADR `2026-08-26-directional-geo-node-self-description.md`)
taught every node to self-describe its OWN cardinal macro-region ("Southern
Sweden / Södra Sverige") deterministically from its own coordinates, uniformly
across its discovery surfaces. The federation search in this server, however,
still understood directional guest phrasing only through a hand-seeded alias
table (`LOCATION_ALIASES`: "southern sweden" → Skåne — one region, one
country). A guest asking for "södra Spanien" found nothing even when a
published node's own coordinates sat squarely in southern Spain. Hand lists per
region do not scale to 10 000 nodes; the node-side layer already solved the
same problem with data, not lists.

A1's own follow-up list defined this track: *"A2 — federations
riktnings-resolver (query → domäner), deterministisk/alfabetisk/no-score, egen
ADR."*

## Decision

1. **Vendored canon.** `lib/geo-directional-core.ts` is a faithful vendored
   mirror of the smart-stays canon (`api/_lib/geo-directional-regions.js` +
   `api/_lib/geo-directional.js`): the band DATA, the country aliases, and
   `computeDirectional`. Same law as `lib/availability-core.ts` /
   `lib/pricing-core.ts` (ADR 0015): any change is mirrored in the smart-stays
   source in the same PR-pair; parity is anchored by the fixtures in
   `src/geo-directional-a2.contract.test.ts` (villa → `se_south`, the Öresund
   country guard, global anchors, determinism, banned-words scan). Country
   aliases have ONE source — the canon. A spelling the canon lacks (e.g. the
   German "Italien") is a canon gap: fix in smart-stays first, then re-vendor.
   Never a local patch.

2. **Query resolver (new, canonical home here).**
   `lib/geo-directional-query.ts` translates a guest's directional phrase into
   ONE band from the canon, deterministically: full-label match in any seeded
   language ("Sur de España"), direction-term + country tokens ("södra
   Spanien"), Scandinavian/German compounds ("Sydsverige", "Süddeutschland"),
   or direction from the region slot + ISO from the country slot. Direction
   vocabulary is DATA (per-language term rows, folded); parsing rules never
   change — coverage grows by rows. A direction with no resolvable country is
   `null`; a country without that band is `null`. Never a guess.

3. **Search integration — additive only.** `propertyMatchesLocation` gains two
   disjuncts: a directional-band match (the property's OWN free-text country +
   coordinates resolve, via the canon, to the band the phrase named) and an
   ISO-normalized country comparison ("Spanien" matches a node storing
   "Spain"). No pre-A2 match is removed; properties without a known country or
   finite coordinates never directional-match (omitted, not guessed — the same
   Öresund doctrine as the node side). The search SELECT now carries
   `latitude, longitude` (public node facts, already published on every
   node's own surfaces).

4. **Alphabetical output.** Search results and unavailable matches are ordered
   by lowercased name (tiebreaks: domain, then propertyId) — deterministic
   across runs, databases, and locales. Match / no-match plus alphabet is the
   whole ordering; there is no score, no confidence, no distance sort, no
   "best match" (federation doctrine: smart-stays ADR
   `2026-05-10-federation-search-no-confidence.md`).

## Red line (held)

Resolving "southern Spain" to `es_south` and filtering nodes whose own
coordinates sit in that band is deterministic, matchable context — the same
fact each node already publishes about itself. It is not a portal: no ranking,
no comparison, no curation, no commerce vocabulary (the banned-words scan
guards the data). Membership in a band is the node's own coordinates, never
HemmaBo's choice.

## Published-app contract compliance (ChatGPT app 2.0.1)

The published metadata snapshot is untouched: no tool added or renamed, no
input/output schema change, no widget or CSP change. A2 changes only how the
server matches a destination phrase — same tool, same inputs, same output
shape, strictly more correct recall. This is the review-free lane OpenAI's own
portal describes ("you can deploy bug fixes without a new version if your
tools match their published definitions and behavior"). The frozen
`hemmabo_search_properties` description ("region matches broadly against
region, city, and country names") now understates the matching — it forbids
nothing and contradicts nothing; the wording catches up in the next submitted
version, whenever that is decided.

## Follow-ups (each its own decision, not built here)

- Mirror the same resolver into the smart-stays platform search surface
  (`api/federation/search.ts`) so both federation search doors answer
  directional phrasing identically.
- Coordinates as an onboarding requirement (dashboard gate) — a node without
  coordinates is silently absent from every directional match.
- Proximity resolution ("near X, max Y km") — separate track on the same
  building blocks (gazetteer + node-side haversine, both live on the node).
- Canon alias growth (e.g. "Italien", "Espagne", "Spanje") — smart-stays
  first, then re-vendor.
