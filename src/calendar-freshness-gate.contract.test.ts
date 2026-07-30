import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const toolsBase = readFileSync(join(repoRoot, "../lib/tools-base.ts"), "utf8");

describe("MCP calendar freshness gate contract", () => {
  it("search availability and booking create block on stale OTA calendar sync", () => {
    assert.match(toolsBase, /from "\.\/ical-freshness\.js"/);
    assert.match(toolsBase, /calendarFreshnessToolBlock\(/);
    assert.match(toolsBase, /case "hemmabo_search_availability"[\s\S]*calendarFreshnessToolBlock/);
    assert.match(toolsBase, /case "hemmabo_booking_create"[\s\S]*calendarFreshnessToolBlock/);
  });
});

describe("MCP channel-mirror field contract (OQ-3, ADR §6 alt 1)", () => {
  const icalFreshness = readFileSync(join(repoRoot, "../lib/ical-freshness.ts"), "utf8");
  const toolDefs = readFileSync(join(repoRoot, "../lib/tool-definitions-base.ts"), "utf8");

  it("outbound reader exists with its OWN reason-code namespace (R2)", () => {
    assert.match(icalFreshness, /export async function checkChannelMirrorState\(/);
    assert.match(icalFreshness, /channel_mirror_stale/);
    assert.match(icalFreshness, /channel_mirror_error/);
    assert.match(icalFreshness, /channel_mirror_unverified/);
    // The outbound section must never emit inbound codes or touch `available`.
    const outboundSection = icalFreshness.slice(
      icalFreshness.indexOf("checkChannelMirrorState"),
    );
    assert.doesNotMatch(outboundSection, /calendar_sync_stale|calendar_sync_unverified/);
    assert.doesNotMatch(outboundSection, /available\s*[:=]/);
  });

  it("both tools attach channel_mirror on success and keep it non-blocking", () => {
    assert.match(toolsBase, /case "hemmabo_search_availability"[\s\S]*checkChannelMirrorState/);
    assert.match(toolsBase, /case "hemmabo_booking_create"[\s\S]*checkChannelMirrorState/);
    // Informational only: the mirror result must never gate a return the way
    // the inbound block does (no `if (...channelMirror...) return`).
    assert.doesNotMatch(toolsBase, /if\s*\([^)]*channelMirror[^)]*\)\s*return/);
  });

  it("outputSchema declares calendar_freshness + channel_mirror for both tools", () => {
    const tools = ["hemmabo_search_availability", "hemmabo_booking_create"];
    for (const tool of tools) {
      const start = toolDefs.indexOf(`"${tool}"`);
      assert.ok(start > -1, `${tool} definition missing`);
      const nextTool = toolDefs.indexOf('name: "hemmabo_', start + 1);
      const block = toolDefs.slice(start, nextTool === -1 ? undefined : nextTool);
      assert.match(block, /calendar_freshness:/, `${tool} saknar calendar_freshness i outputSchema`);
      assert.match(block, /channel_mirror:/, `${tool} saknar channel_mirror i outputSchema`);
    }
  });
});
