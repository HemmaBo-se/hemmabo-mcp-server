# ChatGPT App v2.0.0 — avkodning av det FAKTISKA avslaget + precedens (bevisrecord)

**Datum:** 2026-08-06
**Status:** bevis-/fyndrecord. **INGEN kod ändrad.** Kompletterar och stänger öppna TODO:s i
[2026-08-05-planen (#325)](./2026-08-05-chatgpt-v2-rejection-tool-surface-audit-plan.md).
**Källor (alla verifierade mot primärkälla, inte parafras):**
- OpenAI-avslagsmejlet — verbatim, återgivet i #325.
- OpenAI app-submission-guidelines — hämtad **live 2026-08-06**, verbatim-citat nedan.
- `submission/chatgpt-app-submission.json` @ origin/main (rejected v2-ytan, läst i sin helhet).
- `api/mcp.ts` @ origin/main.
- ChatGPT-appkatalogen: `github.com/rdmgator12/awesome-chatgpt-apps`, Travel-sektionen läst i sin helhet (rådfil).

> **Läs detta dokument som svaret på "varför föll v2 EXAKT?" — inte "är kategorin tillåten?".**
> Kategorifrågan är sekundär kontext (§7). Ryggraden är §1–§2: den exakta avslagsmeningen mappad mot dina egna submission-rader.

---

## 0. TL;DR — det faktiska avslaget, avkodat

- **Avslagsmeningen (verbatim):** *"Your app appears to enable or facilitate commerce for disallowed offerings (e.g., digital goods/services or other prohibited categories)."*
- **Vad den EXAKT träffar** (evidensbaserat mot submissionen, inte gissat):
  1. **In-chat-handel med en tjänst (en vistelse):** `hemmabo_booking_checkout` skapar en Stripe Checkout Session i chatten (testfallet heter ordagrant *"Create a Stripe checkout link"*), plus `booking_create/negotiate/quote/cancel/reschedule`.
  2. **Försäljning/onboarding av en digital SaaS-prenumeration:** `hemmabo_host_readiness_check` + `hemmabo_host_onboarding_link`, förstärkt av appbeskrivningen *"Use it when a host asks how to create their own booking website"* och testfallet *"I want my own booking website with payments straight to my own Stripe account"*.
- **Ärlig gräns:** OpenAI-mejlet är **generiskt** ("appears to … e.g., …") och **namnger inget specifikt verktyg**. Vår rotorsaks-mappning är därför en **evidensbaserad slutsats**, inte OpenAI-bekräftad. Enda sättet att få OpenAI att namnge exakt trigger är **appell-svaret** (se §8).
- **Vad avslaget INTE var:** kategorin (vacation rental). Det är belagt i §7 — men det är kontext, inte svaret på "varför föll vi".

---

## 1. Avslaget, ordagrant

Från OpenAI-avslagsmejlet 2026-08-05 (återgivet i #325):

> "Your app appears to enable or facilitate commerce for disallowed offerings (e.g., digital goods/services or other prohibited categories)."
> "reply directly to this email to initiate an appeal."

**Två saker att notera med ordvalet:**
1. **"appears to"** + **"e.g."** = generiskt mönster-flagg, inte en pekare mot en rad. Ingen enskild tool namnges.
2. Det finns en **öppen appell-kanal** (svara på mejlet). Det är vägen till att få trigger bekräftad i stället för inferred.

---

## 2. Avkodning: avslagsmening → verifierad policy → exakt bevis i submissionen

Avslaget nämner två "disallowed offerings". Båda finns belagda i `submission/chatgpt-app-submission.json`.

### Hink A — "commerce for … services" (en vistelse är en tjänst, transakterad i chatten)

| Bevis i submissionen | Vad det gör (submissionens egna justifications/testfall) | Verifierad policyrad den bryter mot |
|---|---|---|
| `hemmabo_booking_checkout` | "creates a Stripe Checkout Session" → betal-URL. Testfall: *"Create a Stripe checkout link"* | *"may conduct commerce only for physical goods"* + prohibited: *"Link … to a page that explicitly initiates the process to … complete a purchase."* |
| `hemmabo_booking_create` | "Inserts a new booking record" (pending no-payment booking) | commerce/mutation av en tjänst i chatten |
| `hemmabo_booking_negotiate` | skriver quote-snapshot, låser pris | prisförhandling inför köp |
| `hemmabo_booking_quote` | "binding price quote" / lås pris "before checkout" | *"quote a final payable total"* = commerce-facilitating |
| `hemmabo_booking_cancel` | "may issue a Stripe refund" | transaktionshantering (refund) |
| `hemmabo_booking_reschedule` | "issue an additional charge or partial refund" via Stripe | transaktionshantering (charge/refund) |

### Hink B — "digital goods/services" (SaaS-prenumeration)

| Bevis i submissionen | Vad det gör | Verifierad policyrad den bryter mot |
|---|---|---|
| `hemmabo_host_readiness_check` | fit-verdikt för värd som utvärderar HemmaBo (SaaS) | *"Selling digital products or services—including subscriptions—is not allowed"* |
| `hemmabo_host_onboarding_link` | bygger onboarding-URL till HemmaBo-signup | *"must not display subscription plans, initiate new subscriptions, or promote upgrades"* |
| App-beskrivning | *"HemmaBo verifies and **books** … Use it when a host asks **how to create their own booking website**"* | promotar SaaS + bred triggering för säljintent |
| Testfall (host) | *"I want my own booking website with **payments straight to my own Stripe account**"* → `host_readiness_check` | säljer den digitala tjänsten i klartext |

### "or other prohibited categories"
Generisk svans i mejlet. **Inget** i submissionen matchar de faktiska förbudskategorierna (§3) — närmast vore *"High-chargeback, fraud-prone, or abusive travel services"*, men det finns **inget stöd** för att den åberopades. **Övertolka inte den frasen.**

---

## 3. Verifierad OpenAI-policytext (stänger #325 §1-TODO: "analysera exakt formulering")

Hämtad live 2026-08-06 från OpenAI:s app-submission-guidelines. Verbatim, de rader som biter:

- **Physical-goods-regeln:** *"Currently, plugins may conduct commerce only for physical goods. Selling digital products or services—including subscriptions, digital content, tokens, or credits—is not allowed, whether offered directly or indirectly (for example, through freemium upsells)."*
- **Prenumerationer:** *"Plugins must not display subscription plans, initiate new subscriptions, or promote upgrades."*
- **Extern checkout:** *"Plugins should use external checkout, directing users to complete purchases on your own domain."*
- **Länk-förbud (viktig, missas lätt):** prohibited actions inkl. *"Link directly to a checkout or other transactional page"* och *"Link to a page that explicitly initiates the process to upgrade, subscribe, or complete a purchase."*
- **Verktygsbeskrivningar:** *"Tools should behave exactly as their names, descriptions, and inputs indicate."* + *"Descriptions must not recommend overly broad triggering beyond the explicit user intent."*

**Konsekvens för resubmit:** `get_verified_stay_offer` får returnera en URL till värdens **egendoms-/offer-sida**, inte en checkout-deeplink; och beskrivningen måste beskriva vad verktyget FAKTISKT gör (verifiering), inte "book".

Lodging/vacation rental finns **inte** på förbudslistan (verifierad; se §7).

---

## 4. Kod-gapet som gjorde de förbjudna verktygen SYNLIGA (`api/mcp.ts:268`)

```
case "tools/list":
  return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
```

`tools/list` returnerar **hela** `TOOLS` för alla, utan auth. `ANON_TOOLS` (`mcp.ts:389`) gatar bara vilka verktyg som får **anropas** utan Bearer-token — den **döljer dem inte** från listan. Granskarens ChatGPT-klient kör `tools/list` och ser alla 13, inkl. `booking_checkout`.

**Slutsats:** fixen bor i **koden**, inte i submission-JSON:en. En ren JSON med 3 verktyg hjälper inte om servern fortsatt listar 13. OpenAI-ytan måste få en **filtrerad `tools/list`** (separat build/endpoint) utan att röra ytan andra klienter/Anthropic ser (ADR 0004-lockstep).

---

## 5. `submission/chatgpt-app-submission.fixed.json` = FÄLLA (stänger #325 §6-TODO)

Filen lästes 2026-08-06. Den fixar **ingenting**:
- Behåller `hemmabo_booking_checkout` (samma Stripe-motivering).
- **Återinför** `hemmabo_search_similar` + `hemmabo_compare_properties` — marknadsplats-verktygen som togs bort i **PR #282**.
- Beskrivningen säger "15 runtime tools" (stale).

**Använd den ALDRIG. Radera eller ignorera.**

---

## 6. v1.0.0 "Published" är INGEN säker förlaga (CEO-korrigering 2026-08-06)

v1 kom in med **15 tools** (11 federation inkl. search_similar/compare_properties + 2 host + 2 verify) **och en Loom som inte fungerade**, och blev ändå Published. Alltså: v1 togs **in** under ett tidigt/löst skede — den klarade inte dagens stränga physical-goods-granskning. **"Published" ≠ godkänd mot regeln.** Resubmiten byggs mot **skriven policy + avslagsskälet**, aldrig "detta passerade förut". (Git-tool-evolution: 15 → −2 via #282 → 13 = v2, avslaget.)

---

## 7. Precedens — ÄRLIG kalibrering (efter Grok-korrigering 2026-08-06)

**Sekundär kontext.** Bevisar riktningen, inte att en HemmaBo-spegel är godkänd.

**Verifierat (radbelägg i katalogens Travel-sektion):**
- Kategorin lodging/travel är fri. Booking.com, Expedia, enskilda hotell, B&B, semesterbostäder är inne.
- Oberoende STR/semesterbostäder som faktiskt finns i katalogen (namn + rad i rådfilen):
  - Amapas Vacation Rental — "Puerto Vallarta condo rental" (rad 1625)
  - Cortenoi — "Puglia (Italy) holiday rental search" (rad 1639)
  - Seaclub Alcudia — "Mallorca apartment booking" (rad 1717)
  - Sobo Beaches — "Beach hut booking" (rad 1723)
  - Bed-and-Breakfast.it — "book directly with hosts" (rad 1629)
  - HomeToGo — vacation-rental metasök (rad 1672)
  - Direct Host — "Find direct booking websites for vacation rentals" (rad 1644)
  - Book Direct — "book directly with the property to avoid OTA fees" (rad 1631)
- Direktboknings-mönstret (upptäckt → handoff till egen/värddomän) finns representerat och är alltså inte förbjudet.

**Korrigeringar (mina överord, konceded):**
- **"Massor av oberoende semesteruthyrnings-appar" var överord.** Travel har ~149 appar; merparten flyg/tåg/hotellkedjor/OTA. Ren oberoende STR = **en handfull** (listan ovan), inte "massor".
- **"330 appar, läst i sin helhet" var fel etikett.** "330" var en äldre snapshot-siffra; rådfilen är större (~1 866 rader). Jag läste **hela Travel-sektionen** (~149), inte hela repot.
- **"Direct Host ≈ exakt HemmaBos modell" var för starkt.** Vi har **en katalograd** (pitch), inte deras `tools/list`, auth eller om de faktiskt bokar. Likhet i pitch ≠ bevisad likhet i implementation. **Ej reverse-engineerad.**
- **Nowistay ≠ HemmaBos onboarding-idé.** Nowistay är "short-term rental management" (host-ops), inte bevis för att sälja HemmaBo-SaaS i chatten är ok.

**Netto:** precedensen stödjer att kategorin och discovery→handoff-mönstret är fria — den **bevisar inte** att en specifik HemmaBo-yta blir godkänd.

---

## 8. Öppet / ej bekräftat (inga gissningar bokförda som fakta)

- **Appell-svar** för att få OpenAI att namnge exakt trigger (i stället för vår inferens). CEO skickar; agent skriver utkast.
- **`get_verified_stay_offer`s `direct_booking_url`** — landar den på värdens egendoms-/offer-sida eller en checkout-deeplink? **Ej verifierat.** Avgör mot §3 länk-förbudet.
- **Filtrerad `tools/list` för OpenAI-ytan** (separat build/endpoint) — **ej byggt**.
- **Direct Host faktiska verktygs-yta** — **ej reverse-engineerad** (kräver inloggad ChatGPT-session).
- **Anthropic-feedbacken** (villaakerlyckan MCP) — refererad av Grok men **ej sedd i detta record**; måste läsas i original före utkast till svar.

---

## 9. Provenance — varje nyckelclaim etiketterad

| Claim | Källa | Etikett |
|---|---|---|
| Avslagsmeningen (verbatim) | OpenAI-mejl via #325 | **VERBATIM** |
| Physical-goods/subscription/länk-reglerna | OpenAI guidelines, hämtad 2026-08-06 | **VERIFIERAT CITAT** |
| Vilka 8 verktyg som triggar vilken regel | submission.json + policytext | **EVIDENSBASERAD SLUTSATS** (ej OpenAI-bekräftad) |
| `tools/list` returnerar alla 13 | `api/mcp.ts:268` | **VERIFIERAT I KOD** |
| `.fixed.json` = fälla | filen läst | **VERIFIERAT** |
| Kategorin är fri / STR-namnen | katalogens Travel-sektion (radbelägg) | **VERIFIERAT** |
| Direct Host = HemmaBos spegel | en katalograd | **EJ VERIFIERAT** (pitch, ej implementation) |
| Anthropic-feedbackens punkter | Grok | **EJ SETT I ORIGINAL** |

---

## 10. Nästa (beslut till CEO — inte utfört här)

1. **Ordning:** Anthropic (villaakerlyckan) vs OpenAI-resubmit — Grok föreslår Anthropic först (nära grönt, oberoende av OpenAI). Rimligt **om** Anthropic-feedbacken är som beskriven — läs originalet först.
2. **OpenAI reducerad yta** (spikad riktning): `search_properties`, `verify_vacation_rental_node`, `get_verified_stay_offer`→host-URL; ev. `search_availability` (read-only). Inga booking/checkout/host-onboarding. + **kodfixen i `tools/list`** (§4).
3. **Appell-utkast** för att få trigger bekräftad (§8).
