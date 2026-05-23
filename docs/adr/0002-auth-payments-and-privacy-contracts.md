# ADR 0002 — Authentication, Payments and Privacy Contracts

- **Status:** Proposed
- **Date:** 2026-05-12
- **Deciders:** HemmaBo core
- **Verified against:** `origin/main` @ `ebc498a`
- **Related issues:** [#64](https://github.com/HemmaBo-se/hemmabo-mcp-server/issues/64), [#65](https://github.com/HemmaBo-se/hemmabo-mcp-server/issues/65), [#66](https://github.com/HemmaBo-se/hemmabo-mcp-server/issues/66), [#67](https://github.com/HemmaBo-se/hemmabo-mcp-server/issues/67), [#69](https://github.com/HemmaBo-se/hemmabo-mcp-server/issues/69), [#70](https://github.com/HemmaBo-se/hemmabo-mcp-server/issues/70), [#71](https://github.com/HemmaBo-se/hemmabo-mcp-server/issues/71)
- **Supersedes:** nothing
- **Companion:** [ADR 0001](./0001-single-source-of-truth-and-tool-naming.md)

---

## 1. Context

ADR 0001 captured five hygiene bugs (#59–#63). A subsequent audit pass on `origin/main` (same day) surfaced seven additional defects in code paths that handle authentication, money, and personally identifiable information. Each was verified by reading the relevant file on `origin/main`, not against a local working tree.

| Issue | Class | Severity | Evidence on `origin/main` |
|---|---|---|---|
| #64 | Auth | **Critical** | `src/auth.ts:50` exports `validateAuth()` (async, OAuth+key). It is **never imported**. All three runtime entrypoints (`api/mcp.ts:1005`, `api/acp.ts:507`, `src/index.ts:478`) call `validateApiKey()`, which only validates `MCP_API_KEY`. OAuth tokens issued by `/oauth/token` are unusable in production. |
| #65 | DoS / abuse | High | `lib/rate-limit.ts:checkRateLimit` is called only in `api/mcp.ts:1031`. `/oauth/register`, `/oauth/token`, and `/acp/*` are unprotected. |
| #66 | ACP spec / data | High | `api/acp.ts` does not read or enforce `Idempotency-Key`. Retries can create duplicate `bookings` rows. |
| #67 | Privacy | **Critical** | `api/acp.ts:506` gates auth behind `if (isMutation)`. `GET /acp/checkouts/:id` returns `buyer.email`, `buyer.phone_number`, full name, dates, and price to any caller who holds (or guesses) a UUID. |
| #69 | Money precision | High | Five sites convert `price * 100` without rounding (`api/acp.ts:100`, `api/acp.ts:362`, `src/stripe.ts:63`, `src/stripe.ts:123`, `src/stripe.ts:149`). `19.99 * 100 === 1998.9999999999998`. |
| #70 | Money sync | High | No webhook handler exists. `cancelCheckout` swallows refund failures with `catch { /* refund is best-effort */ }` while still marking the booking `cancelled`. |
| #71 | Docs drift | High | `README.md`, `llms.txt`, `api/mcp-manifest.ts`, and `api/server-card.ts` claim things that are not true on `origin/main`. |

These are **runtime correctness** problems, not code-organisation problems. ADR 0001 does not cover them.

## 2. Decision

We adopt three contracts that every endpoint, every payment path, and every public document must satisfy.

### 2.1 Auth contract

Every HTTP endpoint in this repository belongs to exactly one of three categories. The category is declared explicitly at the top of the handler; no implicit defaults.

| Category | Definition | Auth requirement | Rate limit |
|---|---|---|---|
| `public-anon` | Read-only discovery (manifest, server-card, health, OPTIONS) | None | Anon bucket |
| `tool-anon` | Tool calls in `ANON_TOOLS` (search.*, booking.quote) | None | Anon bucket |
| `protected` | Anything that writes state, returns PII, or moves money | **Authorization header validated by `validateAuth()`** — accepts both `MCP_API_KEY` and OAuth bearer tokens from `mcp_access_tokens` | Bearer bucket (per-client) |

Rules:

1. The single canonical validator is `validateAuth()` in `src/auth.ts`. `validateApiKey()` is renamed `validateApiKeyOnly_DEPRECATED` and kept only for test compatibility until the next minor release, then removed.
2. `GET /acp/checkouts/:id` is `protected` (not `public-anon`). HTTP method must not change the auth requirement.
3. Every `protected` handler must call `validateAuth()` **before** any database read, Stripe call, or response shaping.
4. A contract test asserts, for each `protected` route, that an unauthenticated request returns 401 and an authenticated OAuth token returns 200/4xx-on-business-logic (never 401).

This contract fixes #64 and #67 simultaneously.

### 2.2 Payments contract

Every code path that moves money or stores money state must satisfy all six clauses:

1. **Integer minor units only.** Any conversion from a decimal price to Stripe minor units uses `Math.round(price * 100)`. A unit test fixture proves `19.99 → 1999`, `1495.50 → 149550`, `0.10 → 10`.
2. **Idempotency.** `POST /acp/checkouts` and `POST /acp/checkouts/:id/complete` read `Idempotency-Key`. Same key + same body hash → replay cached response. Same key + different body hash → 409 `idempotency_key_in_use`. Key TTL: 24 h. Storage: Supabase table `acp_idempotency_keys` (created in same PR).
3. **Webhook authoritative.** A Stripe webhook handler at `api/stripe-webhook.ts` verifies `Stripe-Signature` (constant-time HMAC against `STRIPE_WEBHOOK_SECRET`) and is the single writer of `bookings.status = confirmed` and `bookings.refund_status`. The synchronous HTTP path may write `pending` / `processing` but **must not** write a terminal status.
4. **No silent payment failures.** No `catch { }` with empty/comment-only body in any file under `api/` or `lib/`. Every caught error is logged with structured context and either re-thrown, surfaced as a non-2xx response, or persisted to the booking row as `refund_failed / refund_error`.
5. **Refund completion before status flip.** `cancelCheckout` does not write `status = cancelled` until either (a) refund succeeded, (b) no refund was needed, or (c) operator manually overrides via an explicit flag. A failed refund returns 502 with the Stripe error code.
6. **Currency stays a string.** No `number` typed currency values. Currency code is always a 3-letter ISO 4217 string compared case-insensitively.

This contract fixes #69, #70, and #66.

### 2.3 Privacy contract

PII = guest name, email, phone, billing address, full booking history.

1. PII is returned **only** to `protected` callers (per §2.1).
2. PII fields are never written to logs. `console.log`/`console.error` calls that touch a `bookings` or `mcp_clients` row must pass through `maskPII()` (existing helper in `lib/pii.ts`; if missing, create it).
3. Error responses to unauthenticated callers contain no PII — only generic `{ error: "<code>" }` shapes.
4. A contract test asserts that `GET /acp/checkouts/:id` without `Authorization` returns 401 with no body field matching `/@/` or a phone-shaped string.

This contract fixes #67 and locks it.

### 2.4 Public-documentation invariant

Every PR that changes an endpoint's auth, request shape, response shape, or behaviour **must** update each of these files in the same PR:

- `README.md`
- `llms.txt`
- `api/mcp-manifest.ts`
- `api/server-card.ts`
- `submission/chatgpt-app-submission.json` (only when on a release branch)

A grep-based CI check (`scripts/check-docs-drift.sh`) compares the canonical tool list in `lib/tool-specs.ts` (introduced by ADR 0001) against each document and fails the build on mismatch. This fixes #71 by making it impossible to drift further.

## 3. Implementation plan

Order is by **risk reduction per unit of work**, not by dependency. Each item is one PR with one drift-guard test. No item may merge before the previous is green.

| Order | PR title | Issue | Files touched | New test |
|---|---|---|---|---|
| 1 | `fix: require auth on GET /acp/checkouts/:id` | #67 | `api/acp.ts` | `acp-auth.contract.test.ts` |
| 2 | `fix: wire validateAuth() into all entrypoints` | #64 | `api/mcp.ts`, `api/acp.ts`, `src/index.ts`, `src/auth.ts` (rename deprecated) | `auth-validator.contract.test.ts` |
| 3 | `fix: Math.round price→cents at all five sites` | #69 | `api/acp.ts`, `src/stripe.ts` | `stripe-cents.test.ts` |
| 4 | `feat: Stripe webhook + non-silent refund` | #70 | new `api/stripe-webhook.ts`, `api/acp.ts`, `supabase/oauth_tables.sql` (or new migration), `vercel.json` | `stripe-webhook.contract.test.ts` |
| 5 | `feat: rate-limit on /oauth/* and /acp/*` | #65 | `api/oauth.ts`, `api/oauth-register.ts`, `api/acp.ts` | `rate-limit-coverage.test.ts` |
| 6 | `feat: Idempotency-Key on /acp/checkouts` | #66 | `api/acp.ts`, new Supabase table | `acp-idempotency.contract.test.ts` |
| 7 | `chore: npm test via glob` | #62 | `package.json`, new `scripts/check-tests-enrolled.mjs` | `test-enrollment.test.ts` |
| 8 | `refactor: single SoT for tool specs` | #63 | new `lib/tool-specs.ts`, `api/mcp.ts`, `src/index.ts`, `src/stdio.ts` | extend `mcp-tool-annotations.contract.test.ts` |
| 9 | `chore: delete src/pricing.ts` | #60 | delete + new singleton guard | `pricing-singleton.test.ts` |
| 10 | `chore: delete src/availability.ts` | #61 | delete + new singleton guard + fail-closed unit tests | `availability-singleton.test.ts` |
| 11 | `feat: register canonical snake_case tool names` | #59 | `lib/tool-specs.ts`, docs | `tool-names-anthropic-strict.test.ts` |
| 12 | `docs: lockstep update of public surface` | #71 | `README.md`, `llms.txt`, `api/mcp-manifest.ts`, `api/server-card.ts`, new `scripts/check-docs-drift.sh` | docs-drift script in CI |

## 4. Consequences

### Positive

- Two `Critical` (#64, #67) issues are closed in PRs 1–2, before any feature work resumes.
- The auth contract makes "which endpoints require auth" a single line of code per handler, instead of folklore.
- The payments contract makes silent money loss impossible to ship.
- Public claims about HemmaBo's security posture become true.

### Negative

- ~12 PRs of focused work before any new feature lands. This is the cost of skipping audits earlier.
- One Supabase migration (idempotency keys table) and one new env var (`STRIPE_WEBHOOK_SECRET`) are needed.

### Risks

- **Existing OAuth-issued tokens (if any in production):** likely zero clients, but if any exist they will start working after PR #2 lands. This is a *positive* behaviour change, not a regression.
- **GET /acp/checkouts/:id callers (if any):** any agent that called this without `Authorization` will start receiving 401. Pre-flight check: search Vercel logs for unauthenticated GETs over the last 30 days; if non-zero, ship PR #1 with a one-week deprecation window and a `Sunset` header.

## 5. Companion repositories

This ADR applies to **`hemmabo-mcp-server`** only. The following sibling repositories are likely to share the same defect patterns and **must** be audited before HemmaBo can claim end-to-end security:

- `hemmabo-smart-stays` — guest-facing site, may share Stripe glue code, almost certainly has its own PII exposure surfaces.
- `villaakerlyckan.se` (host node) — serves `.well-known/mcp.json` and `.well-known/hemmabo.json`; auth model unknown.
- Vera (whatever its repo) — HTTP gateway behind `/api/ai-gateway/*`; auth model unknown.

Each gets its own ADR if defects are found.

## 6. Acceptance for closing this ADR

ADR may be marked **Accepted** when:

- [ ] PRs 1–12 in §3 merged.
- [ ] All seven linked issues (#64–#71) closed.
- [ ] `npm test` glob picks up at least 12 test files.
- [ ] `scripts/check-docs-drift.sh` runs in CI and is green.
- [ ] This file updated to `Status: Accepted` with date.
