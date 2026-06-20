import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RESOURCES, TOOLS, readResource } from "../api/mcp.js";
import {
  HEMMABO_CANONICAL_MCP_ENDPOINT,
  HEMMABO_CHATGPT_WIDGET_DOMAIN,
  HEMMABO_CLAUDE_WIDGET_DOMAIN,
  HEMMABO_LEGACY_WIDGET_URI,
  HEMMABO_PREVIOUS_WIDGET_URI,
  HEMMABO_V1_WIDGET_URI,
  HEMMABO_V2_WIDGET_URI,
  HEMMABO_V3_WIDGET_URI,
  HEMMABO_WIDGET_MIME_TYPE,
  HEMMABO_WIDGET_URI,
  claudeMcpAppDomain,
} from "../lib/apps-widget.js";
import { executeTool } from "../lib/tools.js";

const VILLA_AKERLYCKAN_SUPABASE_ORIGIN = "https://vfalgymbhyfqsyxkvpqg.supabase.co";

describe("ChatGPT Apps verified stay widget", () => {
  function exactDomainCount(domains: readonly string[], origin: string): number {
    return domains.filter((domain) => domain === origin).length;
  }

  it("exposes a current MCP Apps HTML resource with UI metadata", () => {
    const resource = RESOURCES.find((r) => r.uri === HEMMABO_WIDGET_URI);
    assert.ok(resource, "verified stay offer widget must be listed");
    assert.equal(resource.mimeType, HEMMABO_WIDGET_MIME_TYPE);
    assert.equal(resource._meta.ui.prefersBorder, true);
    assert.equal(resource._meta.ui.domain, HEMMABO_CLAUDE_WIDGET_DOMAIN);
    assert.match(resource._meta.ui.domain, /\.claudemcpcontent\.com$/);
    assert.equal(claudeMcpAppDomain(HEMMABO_CANONICAL_MCP_ENDPOINT), HEMMABO_CLAUDE_WIDGET_DOMAIN);
    assert.notEqual(
      claudeMcpAppDomain("https://hemmabo-mcp-server.vercel.app/mcp"),
      HEMMABO_CLAUDE_WIDGET_DOMAIN,
      "Claude directory uses www.hemmabo.com/mcp, not the Vercel hostname"
    );
    assert.equal(exactDomainCount(resource._meta.ui.csp.resourceDomains, VILLA_AKERLYCKAN_SUPABASE_ORIGIN), 1);
    assert.equal(resource._meta["openai/widgetPrefersBorder"], true);
    assert.equal(resource._meta["openai/widgetDomain"], HEMMABO_CHATGPT_WIDGET_DOMAIN);
    assert.equal(resource._meta["openai/widgetDomain"], "https://www.hemmabo.com");
    assert.ok(resource._meta["openai/widgetCSP"]);
    assert.equal(exactDomainCount(resource._meta["openai/widgetCSP"].resource_domains, VILLA_AKERLYCKAN_SUPABASE_ORIGIN), 1);
    assert.ok(resource._meta["openai/widgetDescription"]);
  });

  it("serves the current widget URI plus previous/legacy widget URIs", () => {
    for (const uri of [HEMMABO_WIDGET_URI, HEMMABO_PREVIOUS_WIDGET_URI, HEMMABO_V3_WIDGET_URI, HEMMABO_V2_WIDGET_URI, HEMMABO_V1_WIDGET_URI, HEMMABO_LEGACY_WIDGET_URI]) {
      const result = readResource(uri);
      assert.ok(result, `resource should resolve for ${uri}`);
      const content = result.contents[0];
      assert.equal(content.uri, HEMMABO_WIDGET_URI);
      assert.equal(content.mimeType, HEMMABO_WIDGET_MIME_TYPE);
      assert.match(content.text, /Verified stay offer/);
      assert.doesNotMatch(content.text, /discount badge/i);
      assert.doesNotMatch(content.text, /public vs federation/i);
      assert.doesNotMatch(content.text, /Direct -/);
      assert.doesNotMatch(content.text, /ACP checkout/i);
      assert.doesNotMatch(content.text, /Ask agent to book/i);
      assert.doesNotMatch(content.text, /Confirm guest details before payment/i);
      assert.doesNotMatch(content.text, /booking lifecycle/i);
      assert.match(content.text, /addEventListener\("error"/);
      assert.match(content.text, /referrerpolicy="no-referrer"/);
    }
  });

  it("binds only the render tool to the widget template while keeping data tools data-first", () => {
    const dataTools = [
      "hemmabo_search_properties",
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
      "hemmabo_host_readiness_check",
      "hemmabo_host_onboarding_link",
      "verify_vacation_rental_node",
    ];

    for (const name of dataTools) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} must exist`);
      assert.equal(tool._meta?.["openai/outputTemplate"], undefined);
      assert.equal((tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, undefined);
    }

    const renderTool = TOOLS.find((t) => t.name === "get_verified_stay_offer");
    assert.ok(renderTool, "get_verified_stay_offer must exist");
    assert.equal(renderTool._meta?.["openai/outputTemplate"], HEMMABO_WIDGET_URI);
    assert.equal(renderTool._meta?.["ui/resourceUri"], HEMMABO_WIDGET_URI);
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

  it("keeps widget requests away from quote-lock tools", () => {
    const renderTool = TOOLS.find((t) => t.name === "get_verified_stay_offer");
    assert.ok(renderTool, "get_verified_stay_offer must exist");
    assert.match(renderTool.description, /read-only/i);
    assert.match(renderTool.description, /must not lock a quote/i);
    assert.doesNotMatch(renderTool.description, /book a node\/stay offer/i);

    const negotiateTool = TOOLS.find((t) => t.name === "hemmabo_booking_negotiate");
    assert.ok(negotiateTool, "hemmabo_booking_negotiate must exist");
    assert.equal(negotiateTool.annotations.title, "Lock Price Quote");
    assert.match(negotiateTool.description, /Never use this .*rendering a stay-offer widget/);

    const widgetHtml = readFileSync(new URL("../lib/apps-widget-html.ts", import.meta.url), "utf8");
    assert.doesNotMatch(widgetHtml, /search, quote, or verified stay offer tool/);
    assert.match(widgetHtml, /Open direct booking URL/);
    assert.doesNotMatch(widgetHtml, /Stripe ACP checkout/);
    assert.doesNotMatch(widgetHtml, /Agent-ready checkout/i);
    assert.doesNotMatch(widgetHtml, /booking lifecycle/i);
  });

  it("hydrates from both MCP Apps notifications and ChatGPT globals", () => {
    const widgetHtml = readFileSync(new URL("../lib/apps-widget-html.ts", import.meta.url), "utf8");
    assert.match(widgetHtml, /ui\/notifications\/tool-result/);
    assert.match(widgetHtml, /openai:set_globals/);
    assert.match(widgetHtml, /globals\.toolOutput/);
    assert.match(widgetHtml, /globals\.toolResponseMetadata/);
    assert.match(widgetHtml, /enrichData/);
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
