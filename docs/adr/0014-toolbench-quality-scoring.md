# ADR 0014 — ToolBench (Arcade) quality scoring: methodology of record; adopt Remote model as external quality gate

**Status:** Accepted — CEO-confirmed 2026-08-09. Server submitted to ToolBench under the **Remote** model (endpoint `https://www.hemmabo.com/mcp`, "I'm the author") on 2026-08-09; grade **pending**. **No tool-code changes made by this ADR** — it records the methodology and the audit so future improvement work measures against facts, not memory.
**Related:** Arcade.dev acquired Smithery 2026-08-05 (ToolBench is Arcade's public MCP quality benchmark, toolbench.arcade.dev); ADR 0001 (tool-definition single source of truth + naming); Smithery quality 98 with the locked VRP naming exception.

## Context

ToolBench grades every MCP server in its index and is now the enterprise-facing quality surface for the MCP ecosystem ("only 0.5% earned A & above"). We are listed there as a **Remote** server. We need the scoring methodology captured verbatim — copied from `toolbench.arcade.dev/methodology` on 2026-08-09, not paraphrased — so that when we begin improving the tools we compare against the real rubric and can tell which work moves which number.

## Decision — methodology of record (verbatim)

**Grade thresholds** (weighted average of the evaluated dimensions determines the grade):

| Grade | Score |
|---|---|
| A+ | 90 – 100 |
| A | 80 – 89 |
| B | 70 – 79 |
| C | 60 – 69 |
| D | 50 – 59 |
| F | below 50 |

**Two scoring models** (a server is scored under exactly one):

| Dimension | Local (GitHub repo) | Remote (hosted endpoint) | What it measures |
|---|---|---|---|
| Definition Quality | **50%** | **N/A** | Tool naming, descriptions, parameter schemas, and composability |
| Protocol Compliance | 20% | **40%** | Transport type, tool registration correctness, MCP spec adherence |
| Security Checks | N/A | **30%** | OAuth 2.0, PKCE, transport security, authentication flows |
| Supportability | 30% | **30%** | Maintenance health, community adoption, organizational backing |

Per-dimension detail (verbatim intent):
- **Definition Quality** (Local only): per-tool scoring on naming clarity (verb-first, unambiguous intent), description quality (explains when/why/what it returns), and parameter-schema completeness (typed inputs with constraints + documentation). Overall = average of per-tool scores. **Tools without visible input schemas score zero for that sub-dimension.** Informed by Arcade's 54 Agentic Tool Patterns.
- **Protocol Compliance** (Local + Remote): transport type is the primary signal — **HTTP servers can score up to 100; STDIO-only is capped at 50** (can't be reached by hosted MCP clients). Tool registration correctness and MCP error handling are also evaluated. Optional MCP capabilities (prompts, resources, logging, sampling) are detected but **do not affect the score** — a Tools-only server is fully compliant per spec.
- **Security Checks** (Remote only): OAuth 2.0 flow correctness, **PKCE support (S256)**, client registration, protected-resource metadata, authorization-server discovery (**RFC 8414**), token-endpoint authentication methods, and **401 challenge handling**.
- **Supportability** (Local + Remote): adoption risk + maintenance health. Local signals = GitHub stars, OSS license, last push date, org vs individual ownership, contributor count, release history, fork status, docs, commercial-support indicators. **Remote signals = SLA tier, enterprise support, deployment model, compliance certifications (SOC 2, GDPR), encryption, multi-region availability.**

## What this means for HemmaBo (Remote model)

Our grade is the weighted average of **Protocol Compliance 40% + Security Checks 30% + Supportability 30%**. Definition Quality is **N/A** for us.

- **Protocol Compliance (40%) — strong.** We are HTTP (streamable-http, `https://www.hemmabo.com/mcp`, verified live), so we're eligible for up to 100; Tools-only is fully compliant. Registration correctness is enforced by ADR 0001's single-source tool list + drift guard.
- **Security Checks (30%) — likely strong, verify before claiming full marks.** We implement OAuth 2.0 authorization-code + Dynamic Client Registration (ADR 0003). Confirm against the rubric: PKCE **S256**, protected-resource metadata, RFC 8414 discovery, token-endpoint auth methods, and 401-challenge handling — any gap here is a real, in-scope fix worth doing.
- **Supportability (30%) — likely our ceiling, and mostly out of scope.** The Remote signals reward **enterprise** attributes (SLA tier, SOC 2, multi-region, enterprise support) that HemmaBo, as host-owned booking infrastructure, does not advertise and largely should not chase. Expect this dimension to cap the grade; do not over-invest to move it.

**Key consequence for tool-improvement work:** the 8 ToolBench ecosystem "top issues" (missing descriptions, no output schema, missing parameter constraints, naming, etc.) live under **Definition Quality**, which is **N/A for Remote**. So the Definition-Quality audit below improves **Glama/Smithery** (Capability Quality) and is simply correct tool design — but it **does not move our ToolBench Remote grade.** Do not expect the ToolBench number to change from those fixes.

## Audit of record — 8 ToolBench top issues → 7 patterns → verdict (2026-08-09)

The 13 tools (`lib/tool-definitions-base.ts`, `lib/tool-definitions.ts`) were reviewed against Arcade's patterns. Issues #1 and #7 both map to the Tool Description pattern.

| # | ToolBench top issue | Pattern | Verdict |
|---|---|---|---|
| 1 | Missing descriptions | Tool Description | Clean (exemplary: when/when-not, prerequisites, related tools, auth) |
| 2 | No error handling guidance | Recovery Guide | **Partial** — error output is a flat `{ error: string }` (`lib/vrp.ts`), no structured recovery fields; strong partial coverage via `search_availability` (`reason`+`alternativeDates`+`calendar_freshness`) and rate-limit `retryAfterSec` |
| 3 | No output schema | Response Shaper | Strong — curated/flattened outputs, ISO dates, `official_offer_summary`; minor legacy price-field duplication kept for compat |
| 4 | No pagination guidance | Paginated Result | **Gap, low urgency** — only `hemmabo_search_properties` returns an unbounded array; no `limit`/`cursor`/`has_more`; small live set today, relevant at federation scale |
| 5 | Missing parameter constraints | Constrained Input | **3 gaps** — `guests` has `minimum:1` but no `maximum` (shared `F.guests`, 7 tools); `guestPhone` says E.164 but no `pattern`; `language` fields ISO/BCP-47 in text but unconstrained |
| 6 | Destructive ops unguarded | Confirmation Request | Clean by design — writes key on UUIDs (never fuzzy names); search returns matches + stable ids; write tools say "only after explicit user confirmation" |
| 7 | Naming inconsistencies | (Tool Description) | **LOCKED — will not fix.** The two unprefixed VRP tools (`get_verified_stay_offer`, `verify_vacation_rental_node`) are vendor-neutral on purpose; VRP is an open standard, not HemmaBo property. Also a Definition-Quality item → N/A for Remote regardless |
| 8 | Missing tool annotations | Performance Hint | Strong — rate-limit + idempotency hints, prefer-X guidance, MCP annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`) |

## Planned work (NOT done here — awaits CEO go)

1. **PR-A — Constrained Input (#5):** add a sane `maximum` to `F.guests` (sanity ceiling only — real capacity is server-side `maxGuests`; CEO to pick the cap), a `pattern` to `guestPhone`, and a `pattern`/enum to the `language` fields. Small, contract-tested (`validate-args.contract.test.ts`, `tool-definitions.singleton.test.ts`). Improves Glama/Smithery, not the ToolBench Remote grade.
2. **Security rubric check (#Security):** verify PKCE S256 / RFC 8414 / protected-resource metadata / 401 handling against ADR 0003 — this **does** move the ToolBench Remote grade; own decision.
3. **Recovery Guide (#2)** and **Paginated Result (#4):** larger, forward-looking; separate decisions.

## STOP

Do not prefix the two VRP tools to chase a "Naming" nit, and do not expect Definition-Quality fixes to move the ToolBench **Remote** grade — Definition Quality is N/A for Remote. The Remote levers are Protocol (already strong), Security (verify PKCE/RFC 8414), and Supportability (enterprise signals, largely out of scope).
