---
description: >
  Zero-tolerance end-to-end audit for a HemmaBo TypeScript service
  (MCP server, ACP gateway, Supabase edge function, or sibling node).
  Enumerates every anti-pattern surfaced during the
  hemmabo-mcp-server audit cycle (#59–#71) so a sibling repo can be
  swept with a single command.
mode: agent
tools: ['codebase', 'editFiles', 'runCommands', 'search', 'fetch', 'githubRepo']
---

# Audit prompt — hemmabo-smart-stays / sibling node sweep

You are auditing a HemmaBo TypeScript service. Treat every finding as a
**zero-tolerance bug** — file a GitHub issue per finding, ship a fix per
issue, one PR per fix, stacked branches when the fixes are dependent.
Do **not** batch unrelated changes into a single PR.

## Ground rules

1. Read first, edit second. Identify the live code path before touching anything.
2. One bug → one issue → one branch → one PR. Stack branches when fixes depend on each other.
3. Tests must stay green at every commit. If a PR needs a temporary `skip`, document it in the PR body and open a follow-up issue.
4. No `--no-verify`, no `git push --force` on `main`, no rebase across merged commits.
5. If a finding requires a product decision (hosted vs. self-hosted, pricing model, contractual scope), park it in the tracking issue and continue with the next finding.

## Required reading before starting

Read these files in the target repo (skip silently if absent):

- `README.md`, `llms.txt`, `LAUNCHGUIDE.md`, `glama.json`, `server.json`
- `package.json` (entry points, scripts, dependencies)
- `lib/**/*.ts` (single source of truth helpers — pricing, availability, validation)
- `api/**/*.ts` (Vercel serverless or sibling transport)
- `src/**/*.ts` (stdio bin, contract tests, alternate transports)
- `supabase/**` (SQL schemas, RLS, edge functions)
- `.github/workflows/*.yml` (CI scope)

## Audit checklist — anti-patterns to hunt

For each finding: report the file + line range, why it's a bug, the
proposed fix, and the test that would prevent regression.

### A. Money handling

- [ ] **A1. Float×100 cents.** Any expression of the form `Math.round(amount * 100)` or `Math.floor(price * 100)` where `amount` is a float in major units. Float arithmetic loses precision at scale (e.g. `1.005 * 100 === 100.49999`). Required: integer cents end-to-end OR a single dedicated `toCents()` helper using `Math.round((x * 100) + Number.EPSILON)` with unit tests across edge floats. Reference: `hemmabo-mcp-server#69`.
- [ ] **A2. Cross-currency comparisons.** Comparing or summing two `amount` values that don't share a `currency` field.
- [ ] **A3. Stripe amount mismatch.** Any code path that POSTs to Stripe with a computed amount that wasn't last seen as an integer.
- [ ] **A4. Refund silently swallowed.** `try { stripe.refunds.create(...) } catch { /* ignore */ }`.

### B. Auth & PII

- [ ] **B1. Dead validator.** A `validateAuth()`/`requireBearer()` function that is exported but never called by the request handler. Grep both the import and call sites. Reference: `hemmabo-mcp-server#64`.
- [ ] **B2. Unauthenticated GET returns PII.** Any `GET` handler that loads `guest_name`, `guest_email`, `guest_phone`, `buyer.*`, `email`, `phone` without a Bearer check. Reference: `hemmabo-mcp-server#67`.
- [ ] **B3. PII in logs.** `console.log(JSON.stringify(req.body))` without a redaction pass over `email`, `phone`, `card_number`, `stripe_token`, `spt_token`.
- [ ] **B4. OAuth advertised but not validated.** Manifest advertises `client_credentials` flow but the token is never decoded/checked against the issuing store. Reference: `hemmabo-mcp-server#64`.

### C. Concurrency & idempotency

- [ ] **C1. Missing idempotency-key handling.** Any POST/PUT mutating an external system (Stripe, Resend, Supabase RPC) without reading `Idempotency-Key` header → unique constraint table → return cached response. Reference: `hemmabo-mcp-server#66`.
- [ ] **C2. Stripe webhook absent or non-signature-verified.** `/webhooks/stripe` either missing or accepting unsigned payloads. Reference: `hemmabo-mcp-server#70`.
- [ ] **C3. Silent error swallow in availability.** A `try { await supabase.select(...) } catch { return [] }` that hides RLS / connectivity failures and produces a "available" answer when the system has no information. Required: fail-closed. Reference: `hemmabo-mcp-server` `src/availability.ts` fork (#61).
- [ ] **C4. Booking lock race.** A "check availability → insert booking" flow with no advisory lock or unique constraint. Required: `booking_locks` table with TTL + `ON CONFLICT DO NOTHING` semantics.

### D. Rate limiting

- [ ] **D1. Rate limit on `/mcp` only.** `/oauth/token`, `/oauth/register`, `/acp/*` left uncapped. Reference: `hemmabo-mcp-server#65`.
- [ ] **D2. Fail-open without log.** Rate-limit helper that returns "allow" when Redis is unreachable without logging a counter so the gap is invisible.
- [ ] **D3. Identifier collision.** Anon limit keyed on `x-forwarded-for` first hop without trusting the platform proxy header chain.

### E. Single source of truth & drift

- [ ] **E1. Dual/tri/quad-SoT.** The same constant declared in ≥2 files (tool list, route table, env list, copy strings). Use a contract test that asserts a single declaration. Reference: `hemmabo-mcp-server#63`.
- [ ] **E2. Divergent forks.** Two files with similar names (`src/pricing.ts` vs `lib/pricing.ts`) where one is silently unused. Required: delete the dead fork; add a singleton test. Reference: `hemmabo-mcp-server#60 #61`.
- [ ] **E3. Docs drift.** Public docs (README, llms.txt, LAUNCHGUIDE, glama.json) claim behaviour that the runtime doesn't honour. Required: CI drift-guard. Reference: `hemmabo-mcp-server#71`.
- [ ] **E4. ChatGPT submission drift.** `submission/chatgpt-app-submission.json` lists tool names/descriptions different from the live manifest.

### F. Tool & schema hygiene

- [ ] **F1. Dotted tool names exposed to claude.ai web.** Any `tools/list` response containing a name with `.` — Claude's web regex `^[a-zA-Z0-9_-]{1,64}$` rejects it. Reference: `hemmabo-mcp-server#59`.
- [ ] **F2. Missing `outputSchema`.** Tools without an `outputSchema` lose Smithery quality points and prevent structured-output AI clients from rendering rich results.
- [ ] **F3. `additionalProperties: true` on input.** Allows AI agents to send keys that silently pass through to Supabase filters as `undefined` (literal string `"undefined"` triggers Postgres 22P02). Required: `additionalProperties: false` everywhere.
- [ ] **F4. Required arg not enforced.** `inputSchema.required` lists a field that the dispatcher doesn't fail-fast on. Reference: `hemmabo-mcp-server#47`.

### G. Build & CI

- [ ] **G1. Test glob skip.** Vitest/Node test runner script that globs only `src/**/*.test.ts` while leaving `lib/**/*.test.ts` orphaned. Reference: `hemmabo-mcp-server#62`.
- [ ] **G2. No drift-guard tests.** CI runs only `npm test` with no static check that catches a re-introduced dual-SoT or a re-introduced dotted tool name.
- [ ] **G3. CodeQL incomplete sanitization.** `replace(/\./g, "\\.")` in a regex builder — must escape every metachar via `replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`.
- [ ] **G4. `npm pack` ships `src/` typescript or `dist/src/` stale forks.** Inspect tarball contents.

### H. Operational safety

- [ ] **H1. Destructive command in a non-interactive path.** `rm -rf`, `DROP TABLE`, `supabase db reset` invoked by a script without an explicit confirmation flag.
- [ ] **H2. `process.env.X!` non-null assertion in cold start.** Crashes the function with an unhelpful "Cannot read undefined" instead of a clear "set X" message.
- [ ] **H3. Missing graceful degradation.** Service hard-fails when `STRIPE_SECRET_KEY` or `UPSTASH_REDIS_REST_URL` is unset, instead of returning a friendly "payments disabled" / "rate limit disabled (fail-open)" response.

## Execution sequence

1. **Inventory phase.** Run `gh issue list --state open --label audit` to skip already-tracked findings.
2. **Sweep phase.** Walk the checklist above. For each MATCH, open an issue with:
   - Title: `[area-code] short description (e.g. C1 missing idempotency on POST /acp/checkouts)`
   - Body: code snippet, why it's a bug, proposed fix, regression-test outline, reference to the `hemmabo-mcp-server` precedent issue.
   - Labels: `audit`, plus one of `security`, `correctness`, `drift`, `dx`.
3. **Fix phase.** For each issue in dependency order: create branch `fix/<issue-num>-<slug>`, write the test first, write the fix, run full test suite, commit with `fix(#NN): …` message that explains *why* not just *what*, push, open PR.
4. **Stack discipline.** If fix N depends on fix N-1, base the branch on the previous PR's branch, not main. Mark the dependency in the PR body.
5. **Production verification.** After deploying to Vercel / Supabase, curl the affected endpoint to confirm behaviour changed.
6. **Memory hygiene.** Update `/memories/repo/*.md` with any new pattern that the audit revealed but the checklist didn't cover.
7. **Second pass.** Once the queue is empty, run the entire checklist again from scratch. Audits routinely surface new findings after the first wave because earlier fixes change the call graph.

## Output format for the final report

Produce a single markdown table:

| # | Finding | File:Line | Severity | Issue | PR |
|---|---------|-----------|----------|-------|-----|

Followed by a closing summary: total findings, total fixed, total deferred (with reasons), test count delta, lines-of-code delta.

## Anti-goals

- Do **not** refactor code that isn't a finding. "While I'm in here…" is how regressions get shipped.
- Do **not** add docstrings, comments, or type annotations to code you didn't touch.
- Do **not** rename symbols across the repo to your preferred style — only rename when a bug requires it.
- Do **not** generate placeholder findings to look thorough. An empty report is a valid report.
