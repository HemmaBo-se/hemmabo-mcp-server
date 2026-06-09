import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const toolsBase = readFileSync(join(repoRoot, "../lib/tools-base.ts"), "utf8");

describe("MCP calendar freshness gate contract", () => {
  it("search availability and booking create block on stale OTA calendar sync", () => {
    expect(toolsBase).toContain('from "./ical-freshness.js"');
    expect(toolsBase).toContain("calendarFreshnessToolBlock(");
    expect(toolsBase).toMatch(/case "hemmabo_search_availability"[\s\S]*calendarFreshnessToolBlock/);
    expect(toolsBase).toMatch(/case "hemmabo_booking_create"[\s\S]*calendarFreshnessToolBlock/);
  });
});
