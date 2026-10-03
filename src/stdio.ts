#!/usr/bin/env node
/**
 * Glama Docker build entry — not a published or supported launch.
 *
 * The only start is the remote server: api/mcp.ts, served at
 * https://www.hemmabo.com/mcp. package.json carries no `bin`, so npm installs
 * no command for this file. It exists because Glama's Docker build for the
 * GitHub-repo listing runs `mcp-proxy -- node dist/src/stdio.js` (#238); that
 * command lives in Glama's admin settings, not in this repo. Remove this file
 * only after that build no longer calls it.
 *
 * It reuses the EXACT same JSON-RPC dispatcher (`handleJsonRpc`) over a stdio
 * transport, so the Glama build answers like the live HTTP server. No tool
 * logic is duplicated here; only the transport differs.
 *
 * Tool execution (tools/call) reads Supabase credentials lazily from env at
 * call time. `initialize` and `tools/list` work without any env, which is what
 * the Glama / mcp-proxy healthcheck exercises.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { handleJsonRpc } from "../api/mcp.js";

async function main(): Promise<void> {
  const transport = new StdioServerTransport();

  transport.onerror = (err: unknown) => {
    console.error("[hemmabo-mcp stdio] transport error:", err);
  };

  transport.onmessage = (message: unknown) => {
    void (async () => {
      try {
        const response = await handleJsonRpc(
          message as Parameters<typeof handleJsonRpc>[0],
        );
        // Notifications (e.g. notifications/initialized) return null — nothing
        // to send back over the wire.
        if (response) {
          await transport.send(
            response as unknown as Parameters<typeof transport.send>[0],
          );
        }
      } catch (err: unknown) {
        console.error("[hemmabo-mcp stdio] handler error:", err);
      }
    })();
  };

  await transport.start();
}

main().catch((err: unknown) => {
  console.error("[hemmabo-mcp stdio] fatal:", err);
  process.exit(1);
});
