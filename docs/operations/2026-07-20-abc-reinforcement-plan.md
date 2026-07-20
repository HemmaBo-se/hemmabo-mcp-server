# A/B/C-förstärkningarna — dokumenterat läge och byggordning

**Datum:** 2026-07-20
**Status:** Dokumenterade förstärkningar — inget byggt; var och en väntar på eget "bygg"
**Kontext:** Analyssession 2026-07-20 (kodverifierad i två oberoende granskningsrundor).
Dessa tre är fristående förstärkningar av nodens agent-yta. De ligger
INTE på kritiska vägen till x402-världsbeviset (payer-spike → settlement →
säljarsida → generalrepetition → oberoende körning), men var och en gör
noden mer användbar för en agent.

## A — `hemmabo_booking_preview` ("vad skulle hända"-skylten)

**Gap (verifierat):** Ingen tool visar utfallet av cancel/reschedule innan
de körs. Refund-beloppet beräknas endast inne i den muterande cancel-vägen
(`cancel-booking`-edge-funktionen), reschedule-deltat (`previousPrice/
newPrice/delta/stripeAction`) endast inne i den muterande reschedule-
handlern. `hemmabo_booking_status` returnerar endast råa policyregler,
inte ett beräknat utfall. Beräkningarna föregår mutationen i koden men är
oskiljbara från den — det saknas en ren dry-run-ingång.

**Bygget:** nytt read-only-tool (`readOnlyHint: true, idempotentHint:
true`) som exponerar exakt samma beräkningar före skrivning:
`{ reservationId, action: cancel|reschedule|extend, newCheckIn?,
newCheckOut? }` → `{ would_result_in: { refund | pricing,
availability_ok, committed: false } }`. Inga nya prislager — endast
utbrutna befintliga beräkningar. Notera: tool-antalet ändras (15 → 16),
vilket kräver synk av ALLA räknande ytor (contract-testen
`tool-count-wording` vaktar detta).

**OTA-linjen:** ren per-nod-beräkning, ingen jämförelse. Grön.

## B — Vera/Konversa som nodens agent-anropbara röst

**Läge (verifierat, korrigerat i två steg):** Konversa/Vera har rikare
kontext än tidigare antaget — attesterade amenity-claims, husregler,
policyer, FAQ, live extern kontext (transport/OSM/Ticketmaster) OCH live
tillgänglighet (blockerade datum + bekräftade bokningar, 90-dagarsfönster,
injiceras i systemprompten vid datumfrågor). Den är dock inte en av MCP-
toolsen — endast nåbar via webb-widgeten och guest-wallet-proxyn.

**Bygget:** exponera nodens röst som MCP-tool (wrapper mot property-chat),
så gästens agent kan fråga husets egen sanning agent-till-agent.
**Designvarning som MÅSTE lösas i spec före bygge:** en frittext-LLM-tool
i en deterministisk MCP-yta öppnar (1) prompt-injection-yta, (2) risk att
LLM-svar uppfattas som verifierbara claims. Trolig lösning: separera
deterministisk faktadel (attesterade claims/policyer som strukturerad
data, verifierbar) från konversationsdelen (märkt icke-attesterad).

**OTA-linjen:** noden talar endast för sin egen fastighet. Grön, givet
separationen ovan.

## C — Offert-freshness-handskakning (agent-nonce)

**Läge (verifierat):** Offert-JWS:en saknar nonce/challenge; freshness
enbart via `valid_until` (`generated_at` + `checked_at`-fälten finns men
används inte som replay-skydd). En agent kan inte binda en offert till sin
egen förfrågan.

**Bygget:** valfri `agent_nonce`-parameter på `get_verified_stay_offer`
som ekas ordagrant inne i den signerade payloaden. Spec-ändring i
vrp-spec (v0.2-spåret) + signeringssidan i smart-stays + verifierarsidan
här. **Relation till x402-spåret:** betalnings-bindningen (nonce =
SHA-256 av offert-JWS, vrp-spec `spec/profiles/x402-payment-binding-
v0.2-draft.md`) löser bindningen payment→offert; C löser offert→förfrågan.
Komplementära, medvetet separata (draften §4 avgränsar detta explicit).

**OTA-linjen:** ren äkthetsverifiering per nod. Grön.

## Rekommenderad inbördes ordning när de byggs

A (billigast, ren utbrytning) → C (liten men cross-repo spec-ändring) →
B (störst; kräver spec-beslutet om determinism-separation först).
