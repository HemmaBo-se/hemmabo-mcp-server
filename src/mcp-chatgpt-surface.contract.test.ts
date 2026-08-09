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
import { handleJsonRpc, CHATGPT_TOOL_NAMES, SERVER_DESCRIPTION, SERVER_INSTRUCTIONS } from "../api/mcp.js";

const CTX_CHATGPT = { agent: "test", mcpEndpointUrl: "https://example.test/mcp", surface: "chatgpt" as const };
const CTX_FULL = { agent: "test", mcpEndpointUrl: "https://example.test/mcp", surface: "full" as const };

type ToolsListResult = { result?: { tools?: Array<{ name: string }> } };
type PromptsListResult = { result?: { prompts?: Array<{ name: string }> } };
type CallResult = { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
type InitializeResult = { result?: { serverInfo?: { description?: string }; instructions?: string } };
type ResourcesListResult = { result?: { resources?: Array<{ uri: string }> } };
type ResourcesReadResult = { result?: { contents?: Array<{ uri: string; text?: string }> } };
type ToolsListMetaResult = { result?: { tools?: Array<{ name: string; _meta?: Record<string, unknown> }> } };

const NATIVE_URI = "ui://hemmabo/verified-stay-offer-native-v1.html";
const V9_URI = "ui://hemmabo/verified-stay-offer-v9.html";

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

  it("initialize tells the 3-tool story — no commerce/onboarding/13-tool language", async () => {
    const res = (await handleJsonRpc(
      { jsonrpc: "2.0", method: "initialize", id: 4 },
      CTX_CHATGPT,
    )) as unknown as InitializeResult;
    const text = `${res.result?.serverInfo?.description ?? ""}\n${res.result?.instructions ?? ""}`;
    assert.ok(text.length > 0, "initialize must return description + instructions");
    for (const forbidden of [
      /13 runtime tools/i,
      /onboarding/i,
      /checkout/i,
      /stripe/i,
      /quote-lock/i,
      /booking lifecycles/i,
      /\bACP\b/,
      /\bAP2\b/,
      /\bUCP\b/,
      /booking_create|booking_cancel|booking_quote|booking_negotiate|booking_reschedule|booking_status|search_availability|host_readiness|host_onboarding/,
    ]) {
      assert.ok(!forbidden.test(text), `ChatGPT-surface initialize must not mention ${forbidden}`);
    }
    for (const name of CHATGPT_TOOL_NAMES) {
      assert.ok(text.includes(name), `ChatGPT-surface instructions must name ${name}`);
    }
  });

  it("initialize on the full surface is byte-identical to the canonical constants", async () => {
    const res = (await handleJsonRpc(
      { jsonrpc: "2.0", method: "initialize", id: 5 },
      CTX_FULL,
    )) as unknown as InitializeResult;
    assert.equal(res.result?.serverInfo?.description, SERVER_DESCRIPTION, "full-surface description must be the untouched canonical constant");
    assert.equal(res.result?.instructions, SERVER_INSTRUCTIONS, "full-surface instructions must be the untouched canonical constant");
  });

  it("serves the design-guidelines-native template on the ChatGPT surface only", async () => {
    const list = (await handleJsonRpc({ jsonrpc: "2.0", method: "resources/list", id: 6 }, CTX_CHATGPT)) as unknown as ResourcesListResult;
    assert.deepEqual((list.result?.resources ?? []).map((r) => r.uri), [NATIVE_URI], "ChatGPT resources/list must advertise exactly the native template");

    const full = (await handleJsonRpc({ jsonrpc: "2.0", method: "resources/list", id: 7 }, CTX_FULL)) as unknown as ResourcesListResult;
    assert.deepEqual((full.result?.resources ?? []).map((r) => r.uri), [V9_URI], "full surface must keep advertising the premium v9 template — /mcp is unchanged");

    const read = (await handleJsonRpc({ jsonrpc: "2.0", method: "resources/read", id: 8, params: { uri: NATIVE_URI } }, CTX_CHATGPT)) as unknown as ResourcesReadResult;
    const nativeText = read.result?.contents?.[0]?.text ?? "";
    assert.ok(nativeText.includes("hb-native-v1"), "native template must carry the design-guidelines style layer");
    assert.ok(nativeText.includes("<!DOCTYPE html>"), "native template must be complete HTML");

    const readV9 = (await handleJsonRpc({ jsonrpc: "2.0", method: "resources/read", id: 9, params: { uri: V9_URI } }, CTX_FULL)) as unknown as ResourcesReadResult;
    assert.ok(!(readV9.result?.contents?.[0]?.text ?? "").includes("hb-native-v1"), "v9 must NOT carry the native layer — premium template byte-untouched");
  });

  it("reveals the VRP verification seal only in the expanded view on ChatGPT — flat + static, v9 coin untouched", async () => {
    const read = (await handleJsonRpc({ jsonrpc: "2.0", method: "resources/read", id: 12, params: { uri: NATIVE_URI } }, CTX_CHATGPT)) as unknown as ResourcesReadResult;
    const nativeText = read.result?.contents?.[0]?.text ?? "";
    // Hidden on the compact card, revealed only when the guest expands "more about the stay".
    assert.ok(nativeText.includes(".hbcoin { display: none !important; }"), "native seal must be hidden by default (compact card stays clean)");
    assert.ok(nativeText.includes(".unfold.open ~ .hbcoin { display: block !important; }"), "native seal must be revealed only when the unfold section is open");
    // OpenAI design guidelines: no custom gradients, calm accent — the badge is solid + static.
    assert.ok(nativeText.includes(".hbcoin-in { animation: none !important; }"), "native seal must not spin (calm badge, not decoration)");
    assert.ok(/\.hbf, \.hbb \{ background: #c9a84c !important;/.test(nativeText), "native seal faces must be a solid gold fill (no gradient)");

    // The premium Claude/v9 surface keeps the animated coin, always visible.
    const readV9 = (await handleJsonRpc({ jsonrpc: "2.0", method: "resources/read", id: 13, params: { uri: V9_URI } }, CTX_FULL)) as unknown as ResourcesReadResult;
    const v9Text = readV9.result?.contents?.[0]?.text ?? "";
    assert.ok(!v9Text.includes(".unfold.open ~ .hbcoin"), "v9 must NOT gate the seal to the expanded view — premium coin stays as-is");
  });

  it("points get_verified_stay_offer's render envelope at the native template on ChatGPT, v9 elsewhere", async () => {
    const res = (await handleJsonRpc({ jsonrpc: "2.0", method: "tools/list", id: 10 }, CTX_CHATGPT)) as unknown as ToolsListMetaResult;
    const offer = (res.result?.tools ?? []).find((t) => t.name === "get_verified_stay_offer");
    assert.equal(offer?._meta?.["openai/outputTemplate"], NATIVE_URI, "ChatGPT tools/list must render via the native template");
    assert.equal(offer?._meta?.["ui/resourceUri"], NATIVE_URI);

    const resFull = (await handleJsonRpc({ jsonrpc: "2.0", method: "tools/list", id: 11 }, CTX_FULL)) as unknown as ToolsListMetaResult;
    const offerFull = (resFull.result?.tools ?? []).find((t) => t.name === "get_verified_stay_offer");
    assert.equal(offerFull?._meta?.["openai/outputTemplate"], V9_URI, "full-surface tools/list _meta must stay on v9 — /mcp is unchanged");
  });
});
