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
  `https://www.hemmabo.com/mcp`. There is no standalone HTTP server or stdio
  binary — `src/index.ts` / `src/stdio.ts` were removed (see #212).
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
  (`hemmabo_host_readiness_check`, `hemmabo_host_onboarding_link`) and the VRP
  verification / pure-logic paths still work.
- To enable the DB-backed tools set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
  (service role bypasses RLS; `SUPABASE_ANON_KEY` is used for published reads).
  Optional: `STRIPE_SECRET_KEY`, `MCP_API_KEY` (Bearer auth; unset = open mode),
  Upstash Redis for distributed rate limiting.

### MCP transport

`api/mcp.ts` is a stateless serverless function — each request constructs its own
`StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`). No shared
long-lived connection, so requests don't interfere.
