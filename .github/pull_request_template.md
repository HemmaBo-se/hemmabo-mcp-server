## Why

## What
| File | Change |
|---|---|

## Before (production, measured YYYY-MM-DD HH:MM UTC)

## After

## Checks run
`npx tsc` · `npm test` · `test:enrolled` · `check-docs-drift` · `check-facts-drift` · `check-description-sync` · `check-version-lockstep`

## After merge
When this PR changes the version (AGENTS.md, «A version change is done when it is released»). Replace X.Y.Z in every link.
1. Deploy, then the agent measures `serverInfo.version` on `https://www.hemmabo.com/mcp` and `/mcp/chatgpt`.
2. CEO: [create release vX.Y.Z](https://github.com/HemmaBo-se/hemmabo-mcp-server/releases/new?tag=vX.Y.Z&target=main&title=vX.Y.Z) → "Set as the latest release" ticked → **Publish release**.
3. CEO, if tools or tool text on `/mcp/chatgpt` changed: OpenAI Rescan on the app's MCPs tab.
4. CEO, when Glama's builder answers: [Build & Release](https://glama.ai/mcp/servers/HemmaBo-se/hemmabo-mcp-server/admin/dockerfile).
5. The agent measures npm and the MCP Registry at the new version.
