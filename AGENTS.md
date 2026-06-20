# AGENTS.md — hemmabo-mcp-server

MCP (Model Context Protocol) server for AI-driven, host-owned vacation-rental
booking discovery + VRP (Vacation Rental Protocol) signed-offer verification.
Companion to `hemmabo-smart-stays`. Node.js + TypeScript (Express 5, MCP SDK).

## Cursor Cloud specific instructions

Dependencies are installed by the startup update script (`npm ci`). Node engine
is `>=20 <23`; the Cloud VM ships Node 22.

### Build & run

- **Build first, always:** `npm run build` (`tsc` → `dist/`). `npm start` runs
  `node dist/src/index.js` and will fail if `dist/` is stale/missing.
- **HTTP (Streamable HTTP) server:** `npm start` → listens on **port 3000**.
  - Health: `GET /health` → `200`.
  - MCP endpoint: `POST /mcp` (requires `Accept: application/json, text/event-stream`).
  - `npm run dev` is `tsc --watch` (recompile only — it does NOT start the server).
- **stdio transport:** `node dist/src/stdio.js` (or `npx hemmabo-mcp-server`).
- **Tests:** `npm test` (`node scripts/run-tests.mjs`, Node's built-in runner) —
  all tool logic, VRP verification, and onboarding tools are covered and pass
  without any database.

### Database / env

- The server starts WITHOUT Supabase env and prints
  `⚠ Running without database`. In that mode the federation/booking tools return
  `{"error":"Database not configured…"}`, but the **2 host-onboarding tools**
  (`hemmabo_host_readiness_check`, `hemmabo_host_onboarding_link`) and the
  pure-logic paths still work.
- To enable the DB-backed tools set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
  (service role bypasses RLS; `SUPABASE_ANON_KEY` is used for published reads).
  Optional: `STRIPE_SECRET_KEY`, `MCP_API_KEY` (Bearer auth; unset = open mode),
  Upstash Redis for distributed rate limiting.

### Non-obvious gotcha — `/mcp` is effectively single-flight per process

`src/index.ts` uses ONE shared `McpServer` and calls `server.connect(transport)`
per request without closing the previous transport. In practice only the FIRST
`/mcp` request after process start succeeds; the next one errors
`Error: Already connected to a transport`. A stray `GET /mcp` also consumes that
single connection. **When manually exercising `/mcp`, restart `npm start` before
each request** (or drive it through a proper single MCP client session). The unit
tests don't hit this path, so they're unaffected.
