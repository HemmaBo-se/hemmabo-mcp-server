import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RESOURCES, TOOLS, readResource } from "../api/mcp.js";
import {
  HEMMABO_LEGACY_WIDGET_URI,
  HEMMABO_PREVIOUS_WIDGET_URI,
  HEMMABO_WIDGET_MIME_TYPE,
  HEMMABO_WIDGET_URI,
} from "../lib/apps-widget.js";
import { executeTool } from "../lib/tools.js";

describe("ChatGPT Apps verified stay widget", () => {
  it("exposes a current MCP Apps HTML resource with UI metadata", () => {
    const resource = RESOURCES.find((r) => r.uri === HEMMABO_WIDGET_URI);
    assert.ok(resource, "verified stay offer widget must be listed");
    assert.equal(resource.mimeType, HEMMABO_WIDGET_MIME_TYPE);
    assert.equal(resource._meta.ui.prefersBorder, true);
    assert.equal(resource._meta.ui.domain, "https://hemmabo-mcp-server.vercel.app");
    assert.equal(resource._meta["openai/widgetPrefersBorder"], true);
    assert.equal(resource._meta["openai/widgetDomain"], "https://hemmabo-mcp-server.vercel.app");
    assert.ok(resource._meta["openai/widgetCSP"]);
    assert.ok(resource._meta["openai/widgetDescription"]);
  });

  it("serves the current widget URI plus previous/legacy widget URIs", () => {
    for (const uri of [HEMMABO_WIDGET_URI, HEMMABO_PREVIOUS_WIDGET_URI, HEMMABO_LEGACY_WIDGET_URI]) {
      const result = readResource(uri);
      assert.ok(result, `resource should resolve for ${uri}`);
      const content = result.contents[0];
      assert.equal(content.uri, HEMMABO_WIDGET_URI);
      assert.equal(content.mimeType, HEMMABO_WIDGET_MIME_TYPE);
      assert.match(content.text, /Verified stay offer/);
      assert.doesNotMatch(content.text, /discount badge/i);
      assert.doesNotMatch(content.text, /public vs federation/i);
      assert.doesNotMatch(content.text, /Direct -/);
    }
  });

  it("binds search and verified-offer tools to the widget template while keeping other tools data-first", () => {
    const dataTools = [
      "hemmabo_search_availability",
      "hemmabo_search_similar",
      "hemmabo_compare_properties",
      "hemmabo_booking_quote",
      "hemmabo_booking_create",
      "hemmabo_booking_negotiate",
      "hemmabo_booking_checkout",
      "hemmabo_booking_cancel",
      "hemmabo_booking_status",
      "hemmabo_booking_reschedule",
      "verify_vacation_rental_node",
    ];

    for (const name of dataTools) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} must exist`);
      assert.equal(tool._meta?.["openai/outputTemplate"], undefined);
      assert.equal((tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, undefined);
    }

    const searchTool = TOOLS.find((t) => t.name === "hemmabo_search_properties");
    assert.ok(searchTool, "hemmabo_search_properties must exist");
    assert.equal(searchTool._meta?.["openai/outputTemplate"], HEMMABO_WIDGET_URI);
    assert.deepEqual(searchTool._meta?.ui, { resourceUri: HEMMABO_WIDGET_URI });

    const renderTool = TOOLS.find((t) => t.name === "get_verified_stay_offer");
    assert.ok(renderTool, "get_verified_stay_offer must exist");
    assert.equal(renderTool._meta?.["openai/outputTemplate"], HEMMABO_WIDGET_URI);
    assert.deepEqual(renderTool._meta?.ui, { resourceUri: HEMMABO_WIDGET_URI });
  });

  it("guides ChatGPT to call the render tool after search results", () => {
    const searchTool = TOOLS.find((t) => t.name === "hemmabo_search_properties");
    assert.ok(searchTool, "hemmabo_search_properties must exist");
    assert.match(searchTool.description, /call get_verified_stay_offer/);
    assert.match(searchTool.description, /render the verified stay offer widget/);

    const toolsSource = readFileSync(new URL("../lib/tools-base.ts", import.meta.url), "utf8");
    assert.match(toolsSource, /Call get_verified_stay_offer for the best matching property's domain/);
  });

  it("adds structuredContent from JSON text results for Apps SDK widgets", async () => {
    const result = await executeTool("unknown_tool_for_structured_content_test", {}, {
      supabase: null as never,
      reader: null as never,
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { error: "Unknown tool: unknown_tool_for_structured_content_test" });
  });
});
