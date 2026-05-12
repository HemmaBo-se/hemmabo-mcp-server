# ADR 0001 — Single Source of Truth and MCP Tool Naming

- **Status:** Proposed
- **Date:** 2026-05-12
- **Deciders:** HemmaBo core
- **Verified against:** `origin/main` @ `ebc498a` (commit *“deps(deps-dev): bump @types/node from 25.6.0 to 25.6.2 (#52)”*)
- **Related issues:** [#59](https://github.com/HemmaBo-se/hemmabo-mcp-server/issues/59), [#60](https://github.com/HemmaBo-se/hemmabo-mcp-server/issues/60), [#61](https://github.com/HemmaBo-se/hemmabo-mcp-server/issues/61), [#62](https://github.com/HemmaBo-se/hemmabo-mcp-server/issues/62), [#63](https://github.com/HemmaBo-se/hemmabo-mcp-server/issues/63)
- **Related prior art:** PR #39 / `fix/mcp-manifest-single-sot` and [`src/mcp-manifest-singleton.test.ts`](../../src/mcp-manifest-singleton.test.ts) — the reference pattern for collapsing dual-SoT drift.

---

## 1. Context

A bug audit on 2026-05-12 — triggered by Claude.ai (web) rejecting the deployed MCP server with a `FrontendRemoteMcpToolDefinition.name` regex violation — produced five confirmed bugs (all verified directly against `origin/main`, not against a stale working tree):

| Bug | Class | Severity | Verified on origin/main |
|---|---|---|---|
| #59 — dotted MCP tool names blocked by claude.ai web frontend regex `^[a-zA-Z0-9_-]{1,64}$` | naming convention | high (one major client blocked) | ✅ all 11 tools use `.` in `src/index.ts`, `src/stdio.ts`, `api/mcp.ts` |
| #60 — `src/pricing.ts` duplicates `lib/pricing.ts` (dead but importable) | dual-SoT | medium | ✅ both files exist, content differs |
| #61 — `src/availability.ts` lacks fail-closed DB-error handling that `lib/availability.ts` has | dual-SoT (with safety impact) | **high — double-booking risk if wrong file imported** | ✅ verified line-by-line diff |
| #62 — `src/pricing.test.ts` (40 tests, incl. PII masking + tool-parity) not in `npm test` | CI completeness | high | ✅ `package.json` lists 8 test files but omits `pricing.test.ts` |
| #63 — 11 tool definitions exist three times (`src/index.ts`, `src/stdio.ts`, `api/mcp.ts`); only `api/mcp.ts:TOOLS` is contract-tested | triple-SoT | high | ✅ each file independently declares all 11 tools |

All five share **one root cause**: the project has no codified principle for what is allowed to have a single source of truth, what is allowed to duplicate, and how drift is prevented.

PR #39 solved exactly this for the MCP discovery manifest by:

1. Deleting the duplicate static file.
2. Designating one runtime handler as canonical.
3. Adding a drift-guard test ([`src/mcp-manifest-singleton.test.ts`](../../src/mcp-manifest-singleton.test.ts)) that asserts the duplicate cannot reappear.

This ADR generalises that pattern.

## 2. Decision

We adopt the following principles, immediately and retroactively:

### 2.1 Single-Source-of-Truth (SoT) principle

Every piece of behaviour, schema, or specification in this repository has **exactly one canonical file**. Other modules consume it; they do not redeclare it.

The canonical SoTs in this repo are:

| Concern | Canonical SoT | Consumers |
|---|---|---|
| Pricing math | `lib/pricing.ts` | `lib/tools.ts`, `api/acp.ts`, tests |
| Availability check | `lib/availability.ts` | `lib/tools.ts`, `api/acp.ts`, tests |
| Tool dispatch + name normalization | `lib/tools.ts` (`executeTool`, `TOOL_NAME_ALIASES`) | `src/index.ts`, `src/stdio.ts`, `api/mcp.ts` |
| MCP discovery manifest | `api/mcp-manifest.ts` | `vercel.json` rewrite from `/.well-known/mcp.json` |
| Version string | `package.json` | manifest handler reads it at runtime |
| **Tool specs** (name, description, schemas, annotations) | **NEW: `lib/tool-specs.ts`** (to be created, see §4) | `src/index.ts`, `src/stdio.ts`, `api/mcp.ts` |
| Host federation manifest | `villaakerlyckan.se/.well-known/hemmabo.json` (served by host node, not this repo) | AI clients |

### 2.2 Drift-guard test requirement

Every SoT collapse **must** ship with an automated drift-guard test in the same PR. The test must:

1. Assert that the duplicate file or duplicate declaration cannot exist (`existsSync` check or equivalent).
2. Assert that the canonical SoT is consumed by the expected consumers (import path check or runtime assertion).
3. Live next to existing drift-guards in `src/` and follow the naming pattern `*-singleton.test.ts` or `*.contract.test.ts`.

Reference implementation: [`src/mcp-manifest-singleton.test.ts`](../../src/mcp-manifest-singleton.test.ts).

### 2.3 CI completeness invariant

Tests that exist in the repository must run in CI. The hand-maintained test list in `package.json` is the failure mode that let #62 happen. We will:

1. Switch `npm test` to a glob (`src/*.test.ts`) so adding a new test file automatically enrolls it.
2. Add a guard test that asserts every `*.test.ts` in `src/` is reachable by the `test` script (string-match check) so a future maintainer cannot regress to hand-listing.

### 2.4 MCP tool naming convention

All MCP tool names registered in this repository **must** match the Anthropic-strict regex:

```
^[a-zA-Z0-9_-]{1,64}$
```

This is a strict superset of the MCP spec rule. It is required because Anthropic's claude.ai web client enforces it at the `FrontendRemoteMcpToolDefinition` validation layer, and any tool name that fails this regex breaks remote-MCP installation for every claude.ai web user.

Canonical naming pattern: `hemmabo_<domain>_<action>` (snake_case), matching the existing `TOOL_NAME_ALIASES` values in `lib/tools.ts`. Examples:

| Old (dotted, blocked in claude.ai web) | New (canonical) |
|---|---|
| `search.properties` | `hemmabo_search_properties` |
| `search.availability` | `hemmabo_search_availability` |
| `search.similar` | `hemmabo_search_similar` |
| `search.compare` | `hemmabo_compare_properties` |
| `booking.quote` | `hemmabo_booking_quote` |
| `booking.create` | `hemmabo_booking_create` |
| `booking.negotiate` | `hemmabo_booking_negotiate` |
| `booking.checkout` | `hemmabo_booking_checkout` |
| `booking.cancel` | `hemmabo_booking_cancel` |
| `booking.status` | `hemmabo_booking_status` |
| `booking.reschedule` | `hemmabo_booking_reschedule` |

These canonical names already exist as the right-hand side of the `TOOL_NAME_ALIASES` map in [`lib/tools.ts`](../../lib/tools.ts). The dispatcher already normalises both. **The fix is to register the canonical names publicly and keep the dotted names as backward-compatible aliases during a deprecation window.**

### 2.5 Backwards-compatibility window for tool renames

To avoid breaking existing integrations (current ChatGPT Apps submission, Claude Desktop installs already pinned to `npx hemmabo-mcp-server@3.2.x`, Cursor configs):

1. Canonical snake_case names are registered as the primary tools.
2. Dotted names remain functional via the existing `TOOL_NAME_ALIASES` mapping in `lib/tools.ts`.
3. Dotted names are removed in the next **major** version (4.0.0). No earlier.
4. Deprecation is documented in `README.md` and `CHANGELOG.md` from the rename release onward.

### 2.6 Fail-closed default for safety-critical reads

Any function whose return value drives a booking decision (availability, lock, conflict check, capacity, blackout dates) **must** fail-closed:

- A database error from Supabase → return “unavailable / not allowed”, never “available / allowed”.
- An unexpected exception → caught and reported as unavailable.
- Caller never gets `available: true` from a code path that did not actually observe an empty conflict set.

This rule already exists implicitly in `lib/availability.ts`. It is now formally part of this ADR and must be unit-tested per safety-critical path.

## 3. Consequences

### Positive

- Five known bugs (#59–#63) are addressed by one coherent set of principles rather than five ad-hoc patches.
- claude.ai (web) becomes a supported client.
- Triple-SoT for tool defs is collapsed → schema/annotation drift between transports becomes impossible.
- CI completeness becomes self-enforcing (glob + guard test).
- Future contributors have a written rule to point to, not just folklore from PR #39.

### Negative / cost

- `lib/tool-specs.ts` is new code that all three runtime entrypoints must adopt. One-time refactor.
- Backwards-compat aliases double the registered tool count temporarily (22 instead of 11). This is acceptable because dispatch is already O(1) via the alias map.
- One major-version bump (3.x → 4.0.0) is required to retire dotted names. This is the only breaking change implied.

### Risks (verified, not generic)

- **Vera / villaakerlyckan.se host manifest:** unaffected — already uses snake_case (`negotiate_offer`, `checkout`, `get_booking_status`) and consumes HTTP endpoints, not MCP tool names.
- **Stripe ACP integration:** unaffected — Stripe layer is keyed on UUIDs, not tool names.
- **Smithery / Glama listings:** unaffected — MCP-spec compliant either way; the dotted names were always spec-compliant, this just adds spec-strict-superset names.
- **ChatGPT Apps submission (already in review):** keep `submission/chatgpt-app-submission.json` on dotted names until next re-submission to avoid an in-flight schema change; update at next planned submission.

## 4. Implementation plan (must execute in this order)

Each item is a separate PR. Each PR ships with its own drift-guard test (§2.2). No item may be merged before the previous one is green in CI.

1. **#62 first — CI completeness.** Switch `npm test` to glob. Add the guard test from §2.3. *Without this, the rest of the work runs blind.* Smallest, lowest-risk change.
2. **#63 — Collapse triple-SoT for tool specs.** Create `lib/tool-specs.ts` exporting `TOOL_SPECS: ReadonlyArray<ToolSpec>`. Refactor `api/mcp.ts:TOOLS`, `src/index.ts:server.tool(...)` calls, and `src/stdio.ts:server.tool(...)` calls to consume it. Extend [`src/mcp-tool-annotations.contract.test.ts`](../../src/mcp-tool-annotations.contract.test.ts) to lock the single source and assert no other module redefines a tool name.
3. **#60 — Delete `src/pricing.ts`.** Add singleton guard mirroring `mcp-manifest-singleton.test.ts`.
4. **#61 — Delete `src/availability.ts`.** Add singleton guard. Add explicit unit tests for the three fail-closed branches in `lib/availability.ts` (blocked_dates, bookings, locks query errors).
5. **#59 — Rename to canonical snake_case.** Register snake_case names in the now-single `lib/tool-specs.ts`. Keep dotted names alive via existing `TOOL_NAME_ALIASES` in `lib/tools.ts` until 4.0.0. Update `README.md`, `llms.txt`, `glama.json`, `LAUNCHGUIDE.md`. **Do not** update `submission/chatgpt-app-submission.json` yet (per §3 risk note).
6. **Smoke test on a real claude.ai web account** that the orange `FrontendRemoteMcpToolDefinition.name` warning is gone. Document the verified working URL in the PR description.

## 5. Non-goals (explicitly out of scope for this ADR)

- Federation registry / host onboarding (issues #54–#58) — these are product roadmap items, not SoT hygiene.
- Replacing `lib/tools.ts:executeTool` dispatcher logic — it is already correct and is the canonical SoT for dispatch.
- Removing Vercel / migrating runtime topology.
- Any change to the host manifest on `villaakerlyckan.se`.

## 6. Acceptance for closing this ADR

ADR may be marked **Accepted** when:

- [ ] PR for #62 merged; CI runs all `src/*.test.ts` files.
- [ ] PR for #63 merged; one `TOOL_SPECS` is the only place tools are declared; contract test locks it.
- [ ] PR for #60 merged; `src/pricing.ts` removed; singleton guard green.
- [ ] PR for #61 merged; `src/availability.ts` removed; singleton guard green; fail-closed unit tests added.
- [ ] PR for #59 merged; canonical snake_case names registered; dotted aliases kept; claude.ai web verified working on the deployed Vercel URL.
- [ ] This file updated: `Status: Accepted` and dated.
