# ADR 0013 — Canonical URLs: platform is `www`, node is apex, namespaces are apex-locked

**Status:** Accepted — LOCKED. CEO-confirmed; live-verified 2026-07-23, re-verified 2026-07-27.
**Related:** platform DID `did:web:www.hemmabo.com`; ADR 0004 (agent discovery & packaging lockstep).

## Context

The platform's federation identity is `did:web:www.hemmabo.com`. Apex `hemmabo.com` 308-redirects to `www.hemmabo.com` (`vercel.json`, by design). Node domains (e.g. `villaakerlyckan.se`) anchor identity on the apex (`did:web:villaakerlyckan.se`) and must never redirect. These two facts have been confused repeatedly, letting apex URLs creep back into this repo's metadata, because the rule lived only in the smart-stays repo and had no enforcement here.

## Decision

Four kinds of `hemmabo.com` string, four rules:

| Kind | Rule | Example |
|---|---|---|
| Navigable platform URL | **`https://www.hemmabo.com`** (with www) | homepage, developer.url, "official site", booking/policy links |
| Node domain | **apex, never redirected** (`did:web:<apex>`) | `villaakerlyckan.se` — a `.se` string, not hemmabo.com |
| Namespace / rel URI | **apex-locked identifier — never canonicalize** | `hemmabo.com/ns/discovery/*` (RFC 8288 relation type) |
| CSP / CORS allowlist | apex deliberately beside www — leave | widget `connect_domains`, `Access-Control-Allow-Origin` |

Navigable platform URLs are www because apex is only a redirect, never a canonical address, and www is the DID anchor. Namespace URIs are identifiers whose identity IS the exact string; changing one mints a different relation type and silently breaks discovery.

## Enforcement

`scripts/check-facts-drift.sh` (apex-canonical rule) fails the build if apex `https://`+`hemmabo.com` appears in the navigable metadata surfaces: `README.md`, `package.json`, `glama.json`, `smithery.yaml`, `api/mcp-manifest.ts`, `.plugin/plugin.json`, `api/acp.ts`, `server.json`, `llms.txt`. Run locally: `bash scripts/check-facts-drift.sh`.

The regex intentionally matches apex followed by `/`, so it would also flag a `hemmabo.com/ns/` identifier. It is safe ONLY because none of the nine scanned surfaces contain a `/ns/` identifier. **Never add a file to the scanned list without first grepping it for `hemmabo.com/ns/`** — a namespace URI on a scanned surface would be a false positive, and putting a raw `/ns/` identifier on these navigable surfaces is itself wrong.

smart-stays enforces the same rule via `CANONICAL_ORIGIN` in `contracts/ts/system-facts.ts` + check E in `.github/scripts/asi-gate-facts.ts` (with a `/ns/` + CORS allowlist).

## STOP

If you are about to type the apex form in metadata — don't. Use `https://www.hemmabo.com`.
