# ChatGPT App v2.0.0 — avslag + tvärytligt tool-surface-audit-plan

**Datum:** 2026-08-05
**Status:** planerings-/handoff-dokument. **INGEN kod ändrad.** Arbetet utförs **imorgon (2026-08-06+)**.
**Källor:** OpenAI-avslagsmejlet (2026-08-05), `submission/chatgpt-app-submission.json` @ origin/main, `api/mcp.ts` @ origin/main, [[chatgpt-submission-draft-audit-2026-07-27]], [[stripe-spt-acp-thread-status]], [[chatgpt-connector-is-the-30min-promise]].

---

## 0. TL;DR

- **v1.0.0 = Published (live). v2.0.0 = Rejected.** Launch-mekanismen är INTE nere. Ingen brand.
- **Väg framåt (CEO 2026-08-05): ANSÖK PÅ NYTT** med en compliant, mager verktygsyta.
- **Avslagsorsak:** "enable or facilitate commerce for disallowed offerings (digital goods/services or other prohibited categories)." Grundat i submissionen: **6 transaktionsverktyg** skapar Stripe Checkout Sessions, debiteringar och återbetalningar *inne i ChatGPT* → in-chat-handel utanför OpenAI:s sanktionerade väg (ACP/Instant Checkout).
- **Djupare brist (CEO-insikt 2026-08-05):** flera verktyg är felkonstruerade på en nivå under commerce-policyn — **ett MCP-anrop kan inte styrka en identitet.** Ingen avbokar/ombokar sin bokning eller onboardar som värd genom att låta en agent fylla i ett boknings-ID. `avboka/omboka/checkout/create/host-onboarding` konflaterar "agenten kan anropa funktionen" med "agenten är behörig att agera som den här personen".
- **Primär granskningslins imorgon:** för VARJE verktyg — (a) gör en verklig aktör detta via MCP? (b) kan identitet/behörighet ens uppfyllas av ett verktygsanrop? (c) om det muterar state/pengar/identitet → ska det istället vara en **överlämning till värdens autentiserade domän**?
- **Tvärytligt:** samma verktygsyta publiceras på **npm, MCP-registret, Smithery, Glama** + OpenAI-appen + Perplexity/Grok. Alla ändringar måste propageras i lockstep (ADR 0004).
- **"Behålla checkout om Stripe SPT godkänner?"** Se §5. Kort: inte det *nuvarande* verktyget; dörren till in-chat-handel är ACP (separat spår), fortfarande EU-gated + oprovisionerat. **Koppla loss** app-ansökan från SPT.

---

## 1. Exakt status

| Version | Status | Not |
|---|---|---|
| 1.0.0 | **Published (View in Directory)** | Live. Grandfathered under gamla reglerna. Kan teoretiskt dras vid nästa översyn. |
| 2.0.0 | **Rejected** (2026-08-05) | Blockerar bara uppdateringen, inte 1.0.0. |

OpenAI-mejlets kärna, ordagrant:
> "Your app appears to enable or facilitate commerce for disallowed offerings (e.g., digital goods/services or other prohibited categories)."
> "reply directly to this email to initiate an appeal."

**Att göra imorgon FÖRST:** analysera den EXAKTA formuleringen mot deras app-guidelines + help-center-artikel (länkarna i mejlet är spårnings-redirects — öppna INTE dem; hämta policy-sidorna direkt via WebSearch/WebFetch mot openai.com). Överväg att skicka ett appell-/klargörande-svar för att få OpenAI att namnge exakt verktyg/kategori (så vi inte gissar). CEO skickar; agenten skriver utkast.

---

## 2. Varför avslag — grundat i submissionen (inte gissat)

`submission/chatgpt-app-submission.json` @ origin/main listar 13 verktyg. **6 utför handel/mutation i chatten:**

| Verktyg | Vad det gör (ur submissionens justifications) |
|---|---|
| `hemmabo_booking_checkout` | **skapar Stripe Checkout Session** → betal-URL. Testfall heter ordagrant *"Create a Stripe checkout link"* |
| `hemmabo_booking_create` | skapar bokningsrad ("pending no-payment booking") |
| `hemmabo_booking_quote` | låser pris (skriver quote-snapshot-rad, 15 min) |
| `hemmabo_booking_negotiate` | förhandlar/skriver |
| `hemmabo_booking_reschedule` | **utfärdar Stripe-debitering/återbetalning** |
| `hemmabo_booking_cancel` | **utfärdar Stripe-återbetalning** |

Sekundär misstänkt ("digital goods/services"): `hemmabo_host_onboarding_link` + `hemmabo_host_readiness_check` säljer/onboardar SaaS-prenumerationen (en digital tjänst).

**Slutsats:** appen faciliterar in-chat-handel utanför OpenAI:s sanktionerade commerce-program → policybrott. Detta är HÖGST sannolikt (evidensbaserat), men bekräfta exakt trigger via appell-svaret innan resubmit.

---

## 3. Den djupare bristen: identitet & behörighet (CEO 2026-08-05)

CEO:s skarpa poäng, som går djupare än commerce-policyn:

> "våra tool … avboka, omboka etc och host onboarding via mcp, vem gör det? ingen låter sin mcp-anrop fylla i allt och id-identifiering egentligen."

**Ett MCP-anrop kan inte autentisera en gäst.** Att avboka/omboka en bokning kräver att man bevisar att man är gästen som gjorde den — inte att en agent fyller i ett reservations-ID. Host-onboarding är en identitets- och betalningstung signup som ingen gör via ett verktygsanrop. Dessa verktyg är felkonstruerade oavsett OpenAI-policyn.

**Prejudikat — de 2 verktyg vi redan tog bort:** `hemmabo_search_similar` + `hemmabo_compare_properties`, borttagna i **PR #282 (2026-07-26)** med motiveringen *"no rank/compare across hosts"*. De lät en agent **rangordna/jämföra boenden tvärs över värdar** = marknadsplats/OTA-beteende, tvärtemot HemmaBos identitet (inte OTA, neutral). Fanns i repot sedan minst 2026-05-31 (CEO: ursprung dec 2025, troligen före detta repo), hade hunnit publiceras till Smithery (receipt 2026-05-19). **Lärdom: tool-ytan måste granskas mot identitet OCH mot HemmaBos icke-OTA-identitet — proaktivt, inte när en granskare fångar det.** Se [[verify-before-claiming-missing]], [[vrp-neutrality-strict-no-hemmabo]].

---

## 4. Full 13-verktygs-inventering + granskningsmall (fylls i MED CEO imorgon)

Preliminär bedömning (agentens; **inte beslutad** — besluta tool-för-tool med CEO):

| # | Verktyg | Verklig aktör via MCP? | Identitet/auth möjlig? | Handel? | Prel. verdikt |
|---|---|---|---|---|---|
| 1 | `hemmabo_search_properties` | ja (upptäckt) | nej behövs ej | nej | **BEHÅLL** |
| 2 | `hemmabo_search_availability` | ja (upptäckt) | nej behövs ej | nej | **BEHÅLL** |
| 3 | `get_verified_stay_offer` | ja (verifiering + `direct_booking_url`-handoff) | nej behövs ej | nej (handoff) | **BEHÅLL (kärna)** |
| 4 | `verify_vacation_rental_node` | ja (VRP-verify) | nej behövs ej | nej | **BEHÅLL** |
| 5 | `hemmabo_host_readiness_check` | delvis (read-only fit-verdikt) | nej | gräns (säljer SaaS) | **OMPRÖVA** |
| 6 | `hemmabo_host_onboarding_link` | tveksamt (ingen onboardar via MCP) | nej — signup sker på sajten | gräns (digital tjänst) | **OMPRÖVA / ev. ta bort ur gäst-appen** |
| 7 | `hemmabo_booking_status` | tveksamt (kräver gäst-identitet) | **nej via MCP** | nej | **OMPRÖVA / handoff till gästportal** |
| 8 | `hemmabo_booking_quote` | tveksamt | svag | gräns (pris-lås före checkout) | **TA BORT ur MCP-ytan** |
| 9 | `hemmabo_booking_create` | nej (kräver gäst-identitet) | **nej via MCP** | ja | **TA BORT / handoff** |
| 10 | `hemmabo_booking_negotiate` | nej | **nej via MCP** | ja | **TA BORT** |
| 11 | `hemmabo_booking_checkout` | nej (Stripe checkout) | **nej via MCP** | **ja** | **TA BORT (handoff till värddomän)** |
| 12 | `hemmabo_booking_cancel` | nej (kräver gäst-identitet) | **nej via MCP** | ja (refund) | **TA BORT / gästportal** |
| 13 | `hemmabo_booking_reschedule` | nej (kräver gäst-identitet) | **nej via MCP** | ja (charge/refund) | **TA BORT / gästportal** |

**Prel. netto compliant yta:** ~4–7 read-only upptäckt/verifierings-verktyg. Allt som muterar state/pengar/identitet → **överlämning till värdens autentiserade domän** (direktbokning / gästportal), som redan är live.

---

## 5. "Kan vi behålla checkout om Stripe SPT godkänns?" (CEO-fråga 2026-08-05)

**Kort: inte det nuvarande verktyget — och koppla loss app-ansökan från SPT.**

- Det *nuvarande* `hemmabo_booking_checkout` (rå Stripe Checkout Session-URL i ett verktygssvar) är EXAKT det som fällde ansökan. Skicka in samma igen ⇒ nytt avslag. Det verktyget kan inte stanna, SPT eller ej.
- OpenAI tillåter in-chat-köp — men **bara via sitt eget Agentic Commerce / Instant Checkout-program** (SPT-integrationen byggd med Stripe). Det är ett **separat** bygg- + review-spår från katalog-listningen, med egen merchant-behörighet. "Behålla checkout" = **bygga om det som ACP**, inte behålla nuvarande verktyg.
- Tre grindar kvar, ingen klar (se [[stripe-spt-acp-thread-status]]):
  1. **Stripe SPT-provisionering** — veckans utlovade svar gäller *test-env* (US test mode), inte produktion.
  2. **EU:** SPT är **US+Canada-only**; HemmaBos nod är svensk (SE Express). Produktions-ACP för den faktiska noden är inte nåbar än.
  3. **OpenAI commerce-program-behörighet** för lodging/semesterbostad — **okänt, måste verifieras** (programmet lanserade med specifika merchant-typer).
- **Rekommendation:** ansök om OpenAI-*appen* NU som mager upptäckt+verifiering+handoff (blir godkänd, live). Håll ACP/in-chat-checkout som ett **separat framtida spår** som tänds när de tre grindarna möts. Håll INTE app-ansökan gisslan för Stripes svar (2 dagar). Vi förlorar inget idag: bokningen slutförs redan på värdens egen domän (`direct_booking_url`), live och fungerande; in-chat-checkout var aldrig gästens primära väg.
- Koppling till §3: ACP/SPT ÄR mekanismen som löser "hur betalar agenten å den identifierade användarens vägnar" — via OpenAI+Stripe, inte via att HemmaBo fyller i en checkout. Samma skäl som gör rå checkout fel gör ACP till rätt (framtida) dörr.

---

## 6. Tvärytlig propagering (npm / MCP-registret / Smithery / Glama)

Samma verktygsyta lever på flera distributionsytor. **En verktygsändring måste propageras i lockstep** (se `docs/adr/0004-agent-discovery-and-packaging-lockstep.md`). Ytor att uppdatera + var de definieras (verifiera exakt imorgon):

- **Live `/mcp`** — `api/mcp.ts` (`TOOLS`, `ANON_TOOLS`, `tools/list`-handlern rad ~268).
- **`.well-known/mcp.json` / manifest** — `api/mcp-manifest.ts`, `api/server-card.ts`.
- **MCP-registret / npm** — `server.json` + publicerat npm-paket ([[mcp-v4-release-2026-07-27]]).
- **Smithery** — republish (konto `info-00wt`, byt ALDRIG namn [[smithery-quality-score-naming-gap]], [[smithery-duplicate-account-trap]]).
- **Glama** — kvalitets-scoring ([[glama-tool-quality-scoring]]).
- **OpenAI-submission** — `submission/chatgpt-app-submission.json` + sample_prompts + test_cases.
- **Contract-tester** — `submission-parity.contract.test.ts`, `tool-count-wording.contract.test.ts`, `mcp-anonymous-access.contract.test.ts` m.fl. måste uppdateras till nya ytan.

**OBS:** en ren `submission/*.fixed.json` WIP finns redan i huvudklonen (obekräftad) — kolla den innan nytt arbete.

---

## 7. Gate-mekanik (redan halvbyggd)

- Servern har REDAN `ANON_TOOLS` (7 read-only) vs `AUTH_REQUIRED_TOOLS` (6 transaktions). Anonyma kan inte *anropa* checkout.
- **Lucka:** `tools/list` (`api/mcp.ts:268`) returnerar **alla 13 oavsett auth** → granskaren *ser* checkout.
- **Val imorgon:** (a) verklig **borttagning/omkonstruktion** av felkonstruerade verktyg (CEO:s "skapade av en idiot" lutar hitåt), vs (b) bara gate:a `tools/list` per auth. Sannolikt en blandning: ta bort det som inte hör hemma någonstans; gate:a det som är legitimt bakom auth men inte hör i den anonyma OpenAI-ytan.

---

## 8. Plan för imorgon (ordnad)

1. **Analysera OpenAI:s exakta svar** mot app-guidelines + help-center (hämta sidorna direkt, ej mejl-länkarna). Skriv utkast till appell-/klargörande-svar (CEO skickar).
2. **Tool-för-tool-audit MED CEO** genom identitets-/icke-OTA-linsen (§4) → besluta slutlig yta.
3. **Implementera** i mcp-server: ta bort/gate:a verktyg; uppdatera `TOOLS`/`ANON_TOOLS`/`tools/list`, contract-tester, `submission/*.json`, README, `server.json`, manifest/server-card.
4. **Propagera tvärytligt** (npm / MCP-registret / Smithery / Glama) i lockstep (ADR 0004).
5. **Re-verifiera live** (`/mcp` `tools/list`, `.well-known/mcp.json`) visar den magra ytan.
6. **Resubmit** v2.x till OpenAI med compliant yta + uppdaterade sample-prompts/testfall.

## 9. Öppna beslut för CEO (imorgon)

- Slutlig behåll/ta-bort-lista per verktyg (§4).
- Stannar host-onboarding/readiness kvar i gäst-appen, eller flyttas ut?
- Appell-svar först (få exakt trigger) vs tyst resubmit?
- Verklig borttagning vs auth-gating per verktyg (§7).
- ACP/checkout: bekräfta att det blir ett separat framtida spår, frikopplat från denna resubmit (§5).
