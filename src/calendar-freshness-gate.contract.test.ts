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
