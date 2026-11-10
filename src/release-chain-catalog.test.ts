// scripts/release-chain-catalog.mjs: a catalog page is read three ways
// (reachable, tools, version), and an old or unstated version is never green.
//
// Regression, 2026-11-10 at 7.0.14: the Glama server page and mcp.so listed
// all six tools while their own data said 7.0.12, and release-chain-measure
// marked both rows ✅ because it compared tool names only. Reproduced by the
// independent reviewer on the fetched pages. The fixtures are excerpts of
// those two pages (fetched 2026-11-10 08:22Z) with the version fragment kept
// byte for byte.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Reading = { ok: boolean | "unknown"; reachable: boolean; tools: boolean | null; version: string; detail: string };
type Page = { status: number; text: string };
type Ctx = { toolNames: string[]; retiredNames: string[]; version: string };
type Catalog = {
  checkGlamaServer(page: Page, ctx: Ctx): Reading;
  checkMcpso(page: Page, ctx: Ctx): Reading;
  checkGlamaConnector(page: Page, ctx: Ctx): Reading;
  glamaServerVersions(html: string): string[];
  mcpsoVersions(html: string): string[];
  versionVerdict(found: string[], wanted: string): { state: string; detail: string };
  visible(html: string): string;
  missing(text: string, names: string[]): string[];
  present(text: string, names: string[]): string[];
};

const HERE = dirname(fileURLToPath(import.meta.url));
// A plain .mjs with no type declarations: loaded through a string specifier.
const MODULE: string = "../scripts/release-chain-catalog.mjs";
const catalog = (await import(MODULE)) as Catalog;

const fixture = (name: string) => readFileSync(resolve(HERE, "fixtures/release-chain", name), "utf8");
const GLAMA = fixture("glama-server-7.0.12.html");
const MCPSO = fixture("mcpso-7.0.12.html");

const TOOLS = [
  "hemmabo_check_availability",
  "hemmabo_check_host_readiness",
  "hemmabo_get_host_onboarding_link",
  "hemmabo_search_properties",
  "vrp_get_verified_stay_offer",
  "vrp_verify_node",
];
const RETIRED = ["get_verified_stay_offer", "create_booking", "checkout", "negotiate_offer"];
const ctx = (version: string): Ctx => ({ toolNames: TOOLS, retiredNames: RETIRED, version });

/** What release-chain-measure.mjs counted as ✅ until this change: HTTP 200, every tool listed, no retired name. */
function toolNamesOnly(page: Page, list: string): boolean {
  return page.status === 200 && catalog.missing(list, TOOLS).length === 0 && catalog.present(list, RETIRED).length === 0;
}

describe("release chain: a catalog page is not at the version unless it says so", () => {
  describe("Glama server page", () => {
    const page = { status: 200, text: GLAMA };

    it("the saved page lists all six tools and states 7.0.12: the old tool-names-only check passes it", () => {
      const text = catalog.visible(GLAMA);
      const list = text.slice(text.indexOf("Available Tools"), text.indexOf("Tool Schema Changelog"));
      assert.equal(toolNamesOnly(page, list), true, "the fixture must reproduce the false green");
      assert.deepEqual(catalog.glamaServerVersions(GLAMA), ["7.0.12"]);
    });

    it("is not at 7.0.14: stale version, tools and reachability reported on their own", () => {
      const r = catalog.checkGlamaServer(page, ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.reachable, true);
      assert.equal(r.tools, true);
      assert.equal(r.version, "stale");
      assert.match(r.detail, /reachable; tools: all listed; version 7\.0\.12, not 7\.0\.14/);
    });

    it("is at 7.0.12, the version it states", () => {
      const r = catalog.checkGlamaServer(page, ctx("7.0.12"));
      assert.equal(r.ok, true);
      assert.equal(r.version, "current");
    });

    it("is at 7.0.14 once the page states 7.0.14", () => {
      const r = catalog.checkGlamaServer({ status: 200, text: GLAMA.replace("7.0.12", "7.0.14") }, ctx("7.0.14"));
      assert.equal(r.ok, true);
      assert.equal(r.version, "current");
    });

    it("a page that states no version is unknown, never at the version", () => {
      const silent = GLAMA.replace('\\"version\\",\\"7.0.12\\",', "");
      assert.deepEqual(catalog.glamaServerVersions(silent), []);
      const r = catalog.checkGlamaServer({ status: 200, text: silent }, ctx("7.0.14"));
      assert.equal(r.ok, "unknown");
      assert.notEqual(r.ok, true);
      assert.equal(r.tools, true);
      assert.equal(r.version, "unknown");
      assert.match(r.detail, /version not stated on the page/);
    });

    it("a page that states two versions is unknown, even when one of them is the wanted one", () => {
      const two = GLAMA.replace('\\"version\\",\\"7.0.12\\",', '\\"version\\",\\"7.0.12\\",\\"version\\",\\"7.0.14\\",');
      const r = catalog.checkGlamaServer({ status: 200, text: two }, ctx("7.0.14"));
      assert.equal(r.ok, "unknown");
      assert.match(r.detail, /version unclear, the page states 7\.0\.12 and 7\.0\.14/);
    });

    it("a current version does not excuse a wrong tool list", () => {
      const text = GLAMA.replace("7.0.12", "7.0.14").replace("<span>vrp_verify_node</span>", "<span>create_booking</span>");
      const r = catalog.checkGlamaServer({ status: 200, text }, ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.tools, false);
      assert.equal(r.version, "current");
      assert.match(r.detail, /missing vrp_verify_node, retired names listed: create_booking/);
    });

    it("an unreachable page is not at the version, and nothing is read from its body", () => {
      const r = catalog.checkGlamaServer({ status: 503, text: GLAMA.replace("7.0.12", "7.0.14") }, ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.reachable, false);
      assert.equal(r.tools, null);
      assert.equal(r.version, "unknown");
    });
  });

  describe("mcp.so", () => {
    const page = { status: 200, text: MCPSO };

    it("the saved page lists all six tools and states serverVersion 7.0.12: the old tool-names-only check passes it", () => {
      assert.equal(toolNamesOnly(page, catalog.visible(MCPSO)), true, "the fixture must reproduce the false green");
      assert.deepEqual(catalog.mcpsoVersions(MCPSO), ["7.0.12"]);
    });

    it("is not at 7.0.14: stale version, tools and reachability reported on their own", () => {
      const r = catalog.checkMcpso(page, ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.reachable, true);
      assert.equal(r.tools, true);
      assert.equal(r.version, "stale");
      assert.match(r.detail, /reachable; tools: all listed; version 7\.0\.12, not 7\.0\.14/);
    });

    it("is at 7.0.14 once the page states 7.0.14", () => {
      const r = catalog.checkMcpso({ status: 200, text: MCPSO.replace("7.0.12", "7.0.14") }, ctx("7.0.14"));
      assert.equal(r.ok, true);
      assert.equal(r.version, "current");
    });

    it("the protocol version on the page (2025-06-18) is not read as the server version", () => {
      assert.match(MCPSO, /protocolVersion/);
      assert.deepEqual(catalog.mcpsoVersions(MCPSO), ["7.0.12"]);
    });

    it("a page that states no serverVersion is unknown, never at the version", () => {
      const silent = MCPSO.replace('\\"serverVersion\\":\\"7.0.12\\",', "");
      const r = catalog.checkMcpso({ status: 200, text: silent }, ctx("7.0.14"));
      assert.equal(r.ok, "unknown");
      assert.notEqual(r.ok, true);
      assert.equal(r.version, "unknown");
    });

    it("a current version does not excuse a missing tool", () => {
      const text = MCPSO.replace("7.0.12", "7.0.14").replace("<span>vrp_get_verified_stay_offer</span>", "");
      const r = catalog.checkMcpso({ status: 200, text }, ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.tools, false);
    });
  });

  describe("Glama connector page", () => {
    it("lists the tools and states no version: unknown, never at the version", () => {
      const text = `<html><body><ul>${TOOLS.map((n) => `<li>${n}</li>`).join("")}</ul></body></html>`;
      const r = catalog.checkGlamaConnector({ status: 200, text }, ctx("7.0.14"));
      assert.equal(r.ok, "unknown");
      assert.equal(r.tools, true);
      assert.equal(r.version, "unknown");
    });
  });

  describe("versionVerdict", () => {
    it("current only on exactly one stated version equal to the wanted one", () => {
      assert.equal(catalog.versionVerdict(["7.0.14"], "7.0.14").state, "current");
      assert.equal(catalog.versionVerdict(["7.0.13"], "7.0.14").state, "stale");
      assert.equal(catalog.versionVerdict(["7.0.140"], "7.0.14").state, "stale");
      assert.equal(catalog.versionVerdict([], "7.0.14").state, "unknown");
      assert.equal(catalog.versionVerdict(["7.0.14", "7.0.13"], "7.0.14").state, "unknown");
    });
  });
});
