/**
 * ChatGPT (OpenAI Apps) surface gate.
 *
 * The dedicated /mcp/chatgpt endpoint (api/mcp-chatgpt.ts → serve(...,"chatgpt"))
 * must expose ONLY the read-only discovery + verification allowlist, reject any
 * booking/checkout/host-onboarding tool, and hide the host_start prompt — the
 * surface OpenAI App Review requires (no in-chat commerce, no digital services).
 *
 * Just as importantly, it proves the default "full" surface (/mcp) is UNCHANGED:
 * this change must not touch any other distribution surface. Sibling of
 * submission-parity (submission JSON side) and mcp-tool-annotations (full surface).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleJsonRpc, CHATGPT_TOOL_NAMES } from "../api/mcp.js";

const CTX_CHATGPT = { agent: "test", mcpEndpointUrl: "https://example.test/mcp", surface: "chatgpt" as const };
const CTX_FULL = { agent: "test", mcpEndpointUrl: "https://example.test/mcp", surface: "full" as const };

type ToolsListResult = { result?: { tools?: Array<{ name: string }> } };
type PromptsListResult = { result?: { prompts?: Array<{ name: string }> } };
type CallResult = { result?: { isError?: boolean; content?: Array<{ text?: string }> } };

async function toolNames(ctx: typeof CTX_CHATGPT | typeof CTX_FULL): Promise<string[]> {
  const res = (await handleJsonRpc({ jsonrpc: "2.0", method: "tools/list", id: 1 }, ctx)) as unknown as ToolsListResult;
  return (res.result?.tools ?? []).map((t) => t.name).sort();
}

describe("ChatGPT MCP surface", () => {
  it("tools/list exposes exactly the discovery/verification allowlist", async () => {
    assert.deepEqual(await toolNames(CTX_CHATGPT), [...CHATGPT_TOOL_NAMES].sort());
  });

  it("tools/list hides every booking / checkout / host-onboarding tool", async () => {
    const names = await toolNames(CTX_CHATGPT);
    for (const forbidden of [
      "hemmabo_booking_create",
      "hemmabo_booking_checkout",
      "hemmabo_booking_cancel",
      "hemmabo_host_onboarding_link",
      "hemmabo_host_readiness_check",
    ]) {
      assert.ok(!names.includes(forbidden), `${forbidden} must not appear on the ChatGPT surface`);
    }
  });

  it("tools/call rejects an off-surface tool without executing it", async () => {
    const res = (await handleJsonRpc(
      { jsonrpc: "2.0", method: "tools/call", id: 2, params: { name: "hemmabo_booking_checkout", arguments: {} } },
      CTX_CHATGPT,
    )) as unknown as CallResult;
    assert.equal(res.result?.isError, true, "off-surface tool call must return an error result");
    const text = res.result?.content?.[0]?.text ?? "";
    assert.match(text, /host's own website/i, "rejection must route the user to the host's own website");
  });

  it("prompts/list hides the host onboarding prompt", async () => {
    const res = (await handleJsonRpc({ jsonrpc: "2.0", method: "prompts/list", id: 3 }, CTX_CHATGPT)) as unknown as PromptsListResult;
    const names = (res.result?.prompts ?? []).map((p) => p.name);
    assert.ok(!names.includes("host_start"), "host_start prompt must not appear on the ChatGPT surface");
  });

  it("does NOT change the full /mcp surface (booking tools still present)", async () => {
    const names = await toolNames(CTX_FULL);
    assert.ok(names.includes("hemmabo_booking_checkout"), "full surface must still expose booking_checkout — /mcp is unchanged");
    assert.ok(names.length > CHATGPT_TOOL_NAMES.size, "full surface must expose more tools than the ChatGPT surface");
  });
});
