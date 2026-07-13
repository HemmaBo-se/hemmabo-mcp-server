# Discovery surfaces — ownership map & session pre-flight

Standing doc (not dated): read this BEFORE touching any registry, directory,
listing, or submission work. It exists because two agents (Cursor 2026-06-26,
Claude 2026-07-13) staged the same Docker MCP Registry entry without seeing
each other — the duplicate was only caught in a post-hoc audit.

## Ownership map — which repo owns which surface

| Repo | Owns | Never |
|---|---|---|
| `hemmabo-mcp-server` | The single MCP identity `com.hemmabo/hemmabo-mcp-server`: `server.json`, `glama.json`, `smithery.yaml`, `llms.txt`, ChatGPT Apps kit (`submission/`), all listing copy (`docs/operations/`), drift gates | — |
| `hemmabo-smart-stays` | hemmabo.com product + proxy/discovery (`/.well-known/*`, `/mcp` proxy) | Registry publishing, `MCP_PRIVATE_KEY`, a second MCP identity (ADR 2026-05-16; contract-test enforced) |
| `vrp-spec` | The protocol + vacationrentalprotocol.com | HemmaBo product copy |
| `mcp-registry` (fork of `docker/mcp-registry`) | STAGING ONLY for the Docker MCP catalog entry (`servers/hemmabo/`) | Merging staging PRs into the fork's `main` |
| `awesome-mcp-servers` (fork of `punkpeye/awesome-mcp-servers`) | STAGING ONLY for the awesome-list line (branch `HemmaBo-se-patch-1`) | Merging staging PRs into the fork's `main` |

Forks exist ONLY to open upstream PRs. A fork-internal PR is a review record,
nothing more. Merging it into the fork's `main` diverges the fork from
upstream and submits nothing. Delete/archive forks once upstream merges.

`protocol-registries/well-known-uris` appears in the owner's GitHub sidebar
but is not reachable from agent sessions — if HemmaBo has a pending
registration PR there, only the CEO can check it in a browser.

## Pre-flight checklist — before creating ANYTHING on a discovery surface

1. **List OPEN PRs in every HemmaBo repo AND every fork** (`mcp-registry`,
   `awesome-mcp-servers`, plus anything new in the owner's sidebar).
   Checking `main` + git history is NOT enough — parallel AI sessions
   (Cursor, Grok-driven, other Claude) stage work as open PRs that history
   does not show. This is the step that was skipped on 2026-07-13.
2. **Check the live surface before claiming or creating**: official registry
   via `https://registry.modelcontextprotocol.io/v0/servers?search=hemmabo`
   (reachable from sandboxes), Docker catalog / PulseMCP / MCP.so / Glama /
   Smithery via browser (sandbox network policy usually 403s them — say so
   instead of guessing).
3. **Treat other AIs' lists as hypotheses.** Verify every premise against
   repo receipts before acting ("after Product Hunt" had no receipt anywhere;
   "13 tools" was stale — canonical facts live in `scripts/check-facts-drift.sh`).
4. **One staging PR per surface.** Found an existing one? Improve or supersede
   it explicitly — never open a parallel one.
5. **Sync a fork with upstream and re-run its validator before the upstream
   PR** (`go run ./cmd/validate --name hemmabo` in mcp-registry).
6. **New surface classes need the CEO first**: anything with deal/discount
   framing (AppSumo class), anything that could read as ranking/comparison,
   any new registry identity or key (hard ADR stops).
7. **Never say "live/done" without reading the bytes** — merged ≠ deployed ≠
   listed.

## What to KEEP if everything else is redone

- The registry identity `com.hemmabo/hemmabo-mcp-server` (active at 3.2.16 in
  the official MCP Registry) and the Ed25519 keys behind it — never recreate.
- `server.json` / `glama.json` / `smithery.yaml` / `llms.txt` — the synced
  metadata set, guarded by `check-facts-drift.sh`, `check-docs-drift.sh`, and
  the tool-count/positioning contract tests.
- The ADRs: single-source (2026-05-16), discovery/packaging lockstep
  (ADR 0004), plus the smart-stays contract test blocking a second publisher.
- `submission/` (ChatGPT Apps kit) and
  `docs/operations/2026-07-13-directory-submission-kit.md` (copy + tracker).
- The two fork staging branches until their upstream PRs merge:
  `mcp-registry` → `claude/hemmabo-directory-submissions-amz280`
  (fork PR #3; #2 closed as superseded),
  `awesome-mcp-servers` → `HemmaBo-se-patch-1` (fork PR #1).
