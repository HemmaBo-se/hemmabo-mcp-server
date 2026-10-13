# AGENTS.md — hemmabo-mcp-server

MCP (Model Context Protocol) server for AI-driven, host-owned vacation-rental
booking discovery + VRP (Vacation Rental Protocol) signed-offer verification.
Companion to `hemmabo-smart-stays`. Node.js + TypeScript (Vercel serverless, MCP SDK).

## Cursor Cloud specific instructions

Dependencies are installed by the startup update script (`npm ci`). Node engine
is `>=20 <23`; the Cloud VM ships Node 22.

### Build & run

- **Remote-only / serverless.** Deployed as Vercel serverless functions under
  `api/**`; the live `/mcp` is `api/mcp.ts`, reached at
  `https://www.hemmabo.com/mcp`. There is no standalone HTTP server and no
  published stdio binary: `package.json` has no `bin`. `src/stdio.ts` exists
  only because Glama's Docker build runs `node dist/src/stdio.js` (#238); that
  command is set in Glama's admin, not in this repo. Do not re-add a `bin`.
- **Build:** `npm run build` (`tsc` → `dist/`). `npm run dev` is `tsc --watch`
  (recompile only).
- **Local run:** `vercel dev` exercises the `api/**` functions locally.
  - Health: `GET /health` → `200`.
  - MCP endpoint: `POST /mcp` (requires `Accept: application/json, text/event-stream`).
- **Tests:** `npm test` (`node scripts/run-tests.mjs`, Node's built-in runner) —
  all tool logic, VRP verification, and onboarding tools are covered and pass
  without any database.

### Database / env

- Without Supabase env, the DB-backed federation/booking tools return
  `{"error":"Database not configured…"}`, but the **2 host-onboarding tools**
  (`hemmabo_check_host_readiness`, `hemmabo_get_host_onboarding_link`) and the VRP
  verification / pure-logic paths still work.
- To enable the DB-backed tools set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
  (service role bypasses RLS; `SUPABASE_ANON_KEY` is used for published reads).
  Optional: `STRIPE_SECRET_KEY`, `MCP_API_KEY` (Bearer auth; unset = open mode),
  Upstash Redis for distributed rate limiting.

### MCP transport

`api/mcp.ts` is a stateless serverless function — each request constructs its own
`StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`). No shared
long-lived connection, so requests don't interfere.


## Source truth: sync to origin/main BEFORE reading or building

A stale local clone is the single most likely cause of a wrong conclusion —
reading old file content, or mistaking one repo's facts for another's. Before you
read source to make a claim, or start building:

- Run `git fetch origin && git switch main && git reset --hard origin/main`.
- Create the work branch FROM origin/main: `git switch -c <prefix>/<task> origin/main`.
- Do this for EVERY repo you touch — `vrp-spec`, `hemmabo-mcp-server`,
  `hemmabo-smart-stays` — because cross-repo claims require all of them current.
- NEVER assert a file's content, license, or status from a local clone without
  confirming it against origin/main (or prod). A stale clone is not evidence.
- Don't confuse repos: `vrp-spec` = CC0 (spec text); `hemmabo-mcp-server` =
  Apache-2.0 (reference code). Different licenses, different layers.
- **Canonical URLs:** platform navigable URLs are `https://www.hemmabo.com` (with www); node domains stay apex; `/ns/` URIs are apex-locked identifiers. See `docs/adr/0013-canonical-urls-apex-vs-www.md`. Enforced by `scripts/check-facts-drift.sh`.

## A version change is done when it is released

The version in the lockstep files (`package.json`, `package-lock.json`,
`server.json`, `glama.json`, `.plugin/plugin.json`, `project.faf`) is not a
release. npm and the MCP Registry get nothing until a GitHub release exists.
The release was missed after the merge three times: May (npm on 3.2.8, repo on
3.2.15), October 5.0.1 (three days late) and 6.0.1 (never released; 6.0.2
carries it).

- **Before you build:** compare `package.json` on origin/main with the
  [latest release](https://github.com/HemmaBo-se/hemmabo-mcp-server/releases/latest)
  and npm (`npm view hemmabo-mcp-server version`). If main carries a version
  without a release, tell the CEO first and give the release link below.
- **A PR that changes the version** fills in "After merge" from
  `.github/pull_request_template.md`, with the version in every link.
- **After merge, in this order.** The CEO does the steps marked CEO; the agent
  gives the direct link and measures.
  1. Deploy: Vercel deploys main. Measure `initialize` on
     `https://www.hemmabo.com/mcp` and `/mcp/chatgpt`: `serverInfo.version` is
     the new version.
  2. CEO, the release, one link with tag, target and title filled in:
     `https://github.com/HemmaBo-se/hemmabo-mcp-server/releases/new?tag=vX.Y.Z&target=main&title=vX.Y.Z`
     → "Set as the latest release" ticked → **Publish release**. It runs
     `npm-publish.yml` and `mcp-registry-publish.yml`.
  3. CEO, when tools or tool text on `/mcp/chatgpt` changed: OpenAI Rescan on
     the app's MCPs tab. The page's link is not recorded yet.
  4. CEO, Glama. A green build plus the GitHub release is Glama's
     Auto-Release. When the server page is stale (retired tool names, an old
     version in the changelog) or the build is red:
     [Repository → **Sync Server**](https://glama.ai/mcp/servers/HemmaBo-se/hemmabo-mcp-server/admin/repository)
     until «Current head commit» is main's head, then
     [Dockerfile → **Build & Release**](https://glama.ai/mcp/servers/HemmaBo-se/hemmabo-mcp-server/admin/dockerfile)
     with the pinned SHA empty. 6.0.0 to 7.0.0 went by without a sync: the
     page listed the five retired names and v5.0.0 until 2026-10-13.
  5. The release runs `release-chain.yml`: it measures every surface
     (production, the manifest, npm, the MCP Registry, Glama's connector and
     server page, Smithery, mcp.so, Docker Hub) with
     `scripts/release-chain-measure.mjs` and opens the issue
     «Release vX.Y.Z: the chain», one row per surface, a direct link for every
     hand step. The agent reads the issue, gives the CEO the links for the
     rows that are ❌, and re-runs the workflow (Actions → Release chain →
     Run workflow, same version) after each hand step until every row is ✅.
     The release is done when the issue can be closed.
- Every catalog surface and the full chain: `hemmabo-smart-stays`
  `docs/OPERATIONS/CATALOG-SURFACES.md`, «Kedjan när verktyg eller
  verktygstext ändras».
