// scripts/release-chain-catalog.mjs: a catalog page is read three ways
// (reachable, tools, version), and an old or unstated version is never green.
//
// Regression, 2026-11-10 at 7.0.14: the Glama server page and mcp.so listed
// all six tools while their own data said 7.0.12, and release-chain-measure
// marked both rows ✅ because it compared tool names only. Reproduced by the
// independent reviewer on the fetched pages. The fixtures are excerpts of
// those two pages (fetched 2026-11-10 08:22Z) that keep the record carrying
// the version in the page's own serialization.
//
// Second regression, same day, found by the reviewer at 13b9fc7: the version
// was matched as text across the whole page, so a `version` under
// `archivedRelease`, a `previous_serverVersion`, another server's probe or a
// fragment in an HTML comment was read as this server's version and could turn
// the row green. The version now counts only when it is bound to this
// server's own record; everything else is unknown.
//
// Third round, the reviewer at fdb3f86: any record in Glama's array counted,
// whether or not the page's own server pointed to it (`repository` renamed to
// `archivedRepository` was still green); `previous_qualityDetails:` matched
// the prefix `qualityDetails:`; and a script body wrapped in a JavaScript
// comment was still read. The Glama version is now followed from the page
// data's root through the page's own mcpServer.
//
// Fourth round, the reviewer at e90603d: the hand-written lexer that was to
// tell code from comments and strings let a nested template literal and a
// regular expression after `return` through as code, and both gave a false
// green. The lexer is gone. The outer reading is now the syntax tree of an
// established parser (acorn): the call and the member are nodes of that tree,
// and a script the parser does not accept contributes nothing.
//
// Fifth round, the reviewer at 4eda1a0: the hand-written scan of the HTML took
// text inside another attribute for the script's type, and <scripture> for a
// script; and because the syntax tree was searched whole, a complete record
// inside a function that is never called counted as the listing's. The HTML is
// now read by an established parser (parse5), and the data is read only where
// the page starts itself up, by a named path from the top of the program.
// The counterexamples below are synthetic edits of the fixtures.

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
  mcpsoProbes(html: string): { version: string; checkedAt: string | null }[];
  scriptElements(html: string): { type: string; body: string }[];
  glamaBootstrapChunks(html: string): string[];
  mcpsoQualityDetails(html: string): string[];
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

/** Replace exactly one occurrence, so a counterexample cannot silently be a no-op. */
function swap(text: string, from: string, to: string): string {
  const parts = text.split(from);
  assert.equal(parts.length, 2, `expected exactly one ${JSON.stringify(from)} in the fixture`);
  return parts.join(to);
}
const at714 = (text: string) => swap(text, "7.0.12", "7.0.14");
/** The page with its one <script> element moved inside an HTML comment. */
function scriptInComment(text: string): string {
  const open = text.indexOf("<script");
  const close = text.indexOf("</script>") + "</script>".length;
  assert.ok(open !== -1 && close > open);
  return `${text.slice(0, open)}<!-- ${text.slice(open, close)} -->${text.slice(close)}`;
}
/** The page with the body of its one <script> element rewritten by `wrap`. */
function scriptBodyAs(text: string, wrap: (body: string) => string): string {
  const open = text.indexOf(">", text.indexOf("<script")) + 1;
  const close = text.indexOf("</script>");
  assert.ok(open > 0 && close > open);
  const body = text.slice(open, close);
  assert.equal(body.includes("\n"), false, "the fixture's script body is one line");
  assert.equal(body.includes("'") || body.includes("`") || body.includes("*/"), false, "the wrappers below must not be closed by the body");
  return text.slice(0, open) + wrap(body) + text.slice(close);
}
/** Every way the same script text can sit on the page without being data in its code. */
const NOT_CODE: [string, (body: string) => string][] = [
  ["a JavaScript block comment", (body) => `/* ${body} */`],
  ["a JavaScript line comment", (body) => `// ${body}`],
  ["a block comment after real code", (body) => `var a = 1; /* ${body} */ var b = 2;`],
  ["a single-quoted string", (body) => `var s = '${body}';`],
  ["a template literal", (body) => `var s = \`${body}\`;`],
  ["a legacy <!-- line comment", (body) => `<!-- ${body}`],
  ["a template literal nested in a template literal", (body) => `const s = \`a \${\`${body}\`} b\`;`],
  ["a string after return", (body) => `function f(){return '${body}';}`],
  ["a program the parser does not accept", (body) => `${body} var = ;`],
  // The reviewer's reproduction at 4eda1a0, and its neighbours: code that is declared and never run.
  ["a function that is declared and never called", (body) => `function unusedExample() {\n${body}\n}`],
  ["an arrow function that is assigned and never called", (body) => `const example = () => { ${body} };`],
  ["a function expression that is assigned and never called", (body) => `var example = function () { ${body} };`],
  ["a method of an object that is never used", (body) => `var examples = { show() { ${body} } };`],
  ["a class method that is never used", (body) => `class Example { show() { ${body} } }`],
  ["a branch that is never taken", (body) => `if (false) { ${body} }`],
  ["a block after a return in a function", (body) => `function f() { return; ${body} }`],
  ["a labelled block", (body) => `archive: { ${body} }`],
  ["the right side of &&", (body) => `false && (${body.replace(/;$/, "")});`],
  ["a sequence after another expression", (body) => `0, ${body}`],
  ["an immediately invoked function around it", (body) => `(function () { ${body} })();`],
];
/** The reviewer's reproduction at 4eda1a0, and its neighbours: an opening tag that is not a JavaScript script element. */
const NOT_A_SCRIPT: [string, string, string][] = [
  ["text inside another attribute is not the type", `<script data-note=" type='text/javascript'" type="application/json">`, "</script>"],
  ["the first type attribute is the element's type", `<script type="application/json" type="text/javascript">`, "</script>"],
  ["a quoted > in an attribute does not end the tag", `<script data-x="a>b" type="application/json">`, "</script>"],
  ["an unquoted data type", `<script type=application/json>`, "</script>"],
  ["upper case does not change the type", `<SCRIPT TYPE="APPLICATION/JSON">`, "</SCRIPT>"],
  ["<scripture> is not <script>", `<scripture>`, "</scripture>"],
  ["<script-data> is not <script>", `<script-data>`, "</script-data>"],
  ["a script inside a <template> is inert", `<template><script>`, "</script></template>"],
  ["a script inside a <textarea> is text", `<textarea><script>`, "</script></textarea>"],
  ["a script inside a <title> is text", `<title><script>`, "</script></title>"],
  ["a script inside an <svg> is not an HTML script", `<svg><script>`, "</script></svg>"],
];
/** The page with its one script element's opening and closing tags replaced. */
function scriptTagsAs(text: string, open: string, close: string): string {
  const start = text.indexOf("<script");
  const bodyStart = text.indexOf(">", start) + 1;
  const end = text.indexOf("</script>");
  assert.ok(start !== -1 && end > bodyStart);
  return text.slice(0, start) + open + text.slice(bodyStart, end) + close + text.slice(end + "</script>".length);
}

const page = (text: string, status = 200): Page => ({ status, text });

/** Never ✅: not at the version, whatever else the page says. */
function assertNotGreen(r: Reading, version: string) {
  assert.notEqual(r.ok, true, `must not be at the version: ${r.detail}`);
  assert.equal(r.version, version, r.detail);
}

describe("release chain: a catalog page is not at the version unless it says so", () => {
  describe("Glama server page", () => {
    it("the saved page lists all six tools and states 7.0.12: the old tool-names-only check passes it", () => {
      const text = catalog.visible(GLAMA);
      const list = text.slice(text.indexOf("Available Tools"), text.indexOf("Tool Schema Changelog"));
      assert.equal(toolNamesOnly(page(GLAMA), list), true, "the fixture must reproduce the false green");
      assert.deepEqual(catalog.glamaServerVersions(GLAMA), ["7.0.12"]);
    });

    it("is not at 7.0.14: stale version, tools and reachability reported on their own", () => {
      const r = catalog.checkGlamaServer(page(GLAMA), ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.reachable, true);
      assert.equal(r.tools, true);
      assert.equal(r.version, "stale");
      assert.match(r.detail, /reachable; tools: all listed; version 7\.0\.12, not 7\.0\.14/);
    });

    it("is at 7.0.12, the version it states, and at 7.0.14 once latestRelease states 7.0.14", () => {
      assert.equal(catalog.checkGlamaServer(page(GLAMA), ctx("7.0.12")).ok, true);
      const r = catalog.checkGlamaServer(page(at714(GLAMA)), ctx("7.0.14"));
      assert.equal(r.ok, true);
      assert.equal(r.version, "current");
    });

    it("a 7.0.14 under archivedRelease is not latestRelease's version: unknown", () => {
      const text = swap(at714(GLAMA), '\\"latestRelease\\"', '\\"archivedRelease\\"');
      assert.deepEqual(catalog.glamaServerVersions(text), []);
      assertNotGreen(catalog.checkGlamaServer(page(text), ctx("7.0.14")), "unknown");
    });

    it("a latestRelease 7.0.14 of another repository is not this server's: unknown", () => {
      const text = swap(at714(GLAMA), '\\"HemmaBo-se/hemmabo-mcp-server\\"', '\\"someone-else/hemmabo-mcp-server\\"');
      assertNotGreen(catalog.checkGlamaServer(page(text), ctx("7.0.14")), "unknown");
    });

    it("a record without githubRepository.fullName binds to nothing: unknown", () => {
      const text = swap(at714(GLAMA), '\\"fullName\\"', '\\"shortName\\"');
      assertNotGreen(catalog.checkGlamaServer(page(text), ctx("7.0.14")), "unknown");
    });

    it("a similarly named member (latestReleaseCandidate, versionLabel) is not read: unknown", () => {
      assertNotGreen(catalog.checkGlamaServer(page(swap(at714(GLAMA), '\\"latestRelease\\"', '\\"latestReleaseCandidate\\"')), ctx("7.0.14")), "unknown");
      assertNotGreen(catalog.checkGlamaServer(page(swap(at714(GLAMA), '\\"version\\"', '\\"versionLabel\\"')), ctx("7.0.14")), "unknown");
    });

    it("a record the page's server does not point to is not the page's release: unknown", () => {
      // The reviewer's counterexample at fdb3f86: the record is still in the array, with 7.0.14.
      const text = swap(at714(GLAMA), '\\"repository\\"', '\\"archivedRepository\\"');
      assert.deepEqual(catalog.glamaServerVersions(text), []);
      assertNotGreen(catalog.checkGlamaServer(page(text), ctx("7.0.14")), "unknown");
    });

    it("a broken link anywhere in the chain from the root gives no version: unknown", () => {
      for (const [from, to] of [
        ['\\"loaderData\\"', '\\"staleLoaderData\\"'],
        ['\\"mcpServer\\"', '\\"previousMcpServer\\"'],
        ['\\"githubRepository\\"', '\\"formerGithubRepository\\"'],
        ['[{\\"_1\\":2}', '[{\\"_1\\":-5}'],
        ['{\\"_7\\":8,\\"_9\\":10}', '{\\"_7\\":8,\\"_9\\":999}'],
      ]) {
        assertNotGreen(catalog.checkGlamaServer(page(swap(at714(GLAMA), from, to)), ctx("7.0.14")), "unknown");
      }
    });

    it("the release of another server's page data (another slug) is not this server's: unknown", () => {
      const text = swap(at714(GLAMA), '\\"slug\\",\\"hemmabo-mcp-server\\"', '\\"slug\\",\\"another-mcp-server\\"');
      assertNotGreen(catalog.checkGlamaServer(page(text), ctx("7.0.14")), "unknown");
    });

    it("an entry appended to the array, bound to nothing, does not count", () => {
      // A complete repository record with 7.0.14 that nothing points to, next to the bound 7.0.12.
      const extra = ',{\\"_13\\":26,\\"_17\\":18},{\\"_15\\":27},\\"7.0.14\\"]"';
      const text = swap(GLAMA, ']");</script>', `${extra.slice(0, -2)}]");</script>`);
      assert.deepEqual(catalog.glamaServerVersions(text), ["7.0.12"]);
      const r = catalog.checkGlamaServer(page(text), ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.version, "stale");
    });

    it("a call that is not streamController.enqueue is not the page data: unknown", () => {
      for (const [from, to] of [
        ["streamController.enqueue(", "streamController.enqueueLater("],
        ["streamController.enqueue(", "previousStreamController.enqueue("],
        ["streamController.enqueue(", "streamController.archive.enqueue("],
      ]) {
        assertNotGreen(catalog.checkGlamaServer(page(swap(at714(GLAMA), from, to)), ctx("7.0.14")), "unknown");
      }
    });

    for (const [where, wrap] of NOT_CODE) {
      it(`page data inside ${where} is not read: unknown`, () => {
        const text = scriptBodyAs(at714(GLAMA), wrap);
        assert.deepEqual(catalog.glamaBootstrapChunks(text), []);
        assertNotGreen(catalog.checkGlamaServer(page(text), ctx("7.0.14")), "unknown");
      });
    }

    for (const [what, open, close] of NOT_A_SCRIPT) {
      it(`${what}: the page data is not read, unknown`, () => {
        const text = scriptTagsAs(at714(GLAMA), open, close);
        assert.deepEqual(catalog.glamaBootstrapChunks(text), []);
        assertNotGreen(catalog.checkGlamaServer(page(text), ctx("7.0.14")), "unknown");
      });
    }

    it("page data that sits only in an HTML comment is not read: unknown", () => {
      const text = scriptInComment(at714(GLAMA));
      assert.deepEqual(catalog.scriptElements(text), []);
      assertNotGreen(catalog.checkGlamaServer(page(text), ctx("7.0.14")), "unknown");
    });

    it("a version that is not a version (a number, a range) is not read: unknown", () => {
      assertNotGreen(catalog.checkGlamaServer(page(swap(GLAMA, '\\"7.0.12\\"', "7")), ctx("7.0.14")), "unknown");
      assertNotGreen(catalog.checkGlamaServer(page(swap(GLAMA, "7.0.12", "^7.0.14")), ctx("7.0.14")), "unknown");
    });

    it("an unrelated \"version\",\"7.0.12\" fragment does not make the row stale when the release is unknown", () => {
      const unbound = swap(GLAMA, '\\"latestRelease\\"', '\\"archivedRelease\\"');
      const text = unbound.replace("</body>", '<script>var other = ["version","7.0.12"];</script></body>');
      const r = catalog.checkGlamaServer(page(text), ctx("7.0.14"));
      assert.equal(r.ok, "unknown");
      assert.equal(r.version, "unknown");
    });

    it("an unrelated \"version\",\"7.0.14\" fragment does not make a stale page current", () => {
      const text = GLAMA.replace("</body>", '<script>var other = ["version","7.0.14"]; var s = "\\"version\\",\\"7.0.14\\"";</script><!-- "version","7.0.14" --></body>');
      const r = catalog.checkGlamaServer(page(text), ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.version, "stale");
    });

    it("two records for this repository with different versions are unknown, even when one is the wanted one", () => {
      const script = GLAMA.slice(GLAMA.indexOf("<script"), GLAMA.indexOf("</script>") + "</script>".length);
      const text = GLAMA.replace("</body>", `${at714(script)}</body>`);
      assert.deepEqual(catalog.glamaServerVersions(text), ["7.0.12", "7.0.14"]);
      const r = catalog.checkGlamaServer(page(text), ctx("7.0.14"));
      assert.equal(r.ok, "unknown");
      assert.match(r.detail, /version unclear, the page states 7\.0\.12 and 7\.0\.14/);
    });

    it("page data that cannot be decoded is unknown", () => {
      const text = swap(at714(GLAMA), '\\"repository\\",', '\\"repository\\" ');
      assertNotGreen(catalog.checkGlamaServer(page(text), ctx("7.0.14")), "unknown");
    });

    it("a current version does not excuse a wrong tool list", () => {
      const text = swap(at714(GLAMA), "<span>vrp_verify_node</span>", "<span>create_booking</span>");
      const r = catalog.checkGlamaServer(page(text), ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.tools, false);
      assert.equal(r.version, "current");
      assert.match(r.detail, /missing vrp_verify_node, retired names listed: create_booking/);
    });

    it("a tool name that sits only in an HTML comment is not listed", () => {
      const text = swap(at714(GLAMA), "<li><span>vrp_verify_node</span></li>", "<!-- <li><span>vrp_verify_node</span></li> -->");
      const r = catalog.checkGlamaServer(page(text), ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.tools, false);
    });

    it("an unreachable page is not at the version, and nothing is read from its body", () => {
      const r = catalog.checkGlamaServer(page(at714(GLAMA), 503), ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.reachable, false);
      assert.equal(r.tools, null);
      assert.equal(r.version, "unknown");
    });
  });

  describe("mcp.so", () => {
    it("the saved page lists all six tools and its probe states serverVersion 7.0.12: the old tool-names-only check passes it", () => {
      assert.equal(toolNamesOnly(page(MCPSO), catalog.visible(MCPSO)), true, "the fixture must reproduce the false green");
      assert.deepEqual(catalog.mcpsoProbes(MCPSO), [{ version: "7.0.12", checkedAt: "2026-11-03T19:34:47.121Z" }]);
    });

    it("is not at 7.0.14: stale version with the date of mcp.so's probe, tools and reachability on their own", () => {
      const r = catalog.checkMcpso(page(MCPSO), ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.reachable, true);
      assert.equal(r.tools, true);
      assert.equal(r.version, "stale");
      assert.match(r.detail, /reachable; tools: all listed; version 7\.0\.12, not 7\.0\.14 \(mcp\.so's own probe of 2026-11-03T19:34:47\.121Z\)/);
    });

    it("is at 7.0.14 once the probe states 7.0.14", () => {
      const r = catalog.checkMcpso(page(at714(MCPSO)), ctx("7.0.14"));
      assert.equal(r.ok, true);
      assert.equal(r.version, "current");
    });

    it("previous_serverVersion 7.0.14 is not serverVersion: unknown", () => {
      const text = swap(at714(MCPSO), '\\"serverVersion\\"', '\\"previous_serverVersion\\"');
      assert.deepEqual(catalog.mcpsoVersions(text), []);
      assertNotGreen(catalog.checkMcpso(page(text), ctx("7.0.14")), "unknown");
    });

    it("a probe of another server (unrelated-mcp-server) at 7.0.14 is not this server's: unknown", () => {
      const text = swap(at714(MCPSO), '\\"serverName\\":\\"hemmabo-mcp-server\\"', '\\"serverName\\":\\"unrelated-mcp-server\\"');
      assertNotGreen(catalog.checkMcpso(page(text), ctx("7.0.14")), "unknown");
    });

    it("a probe of another endpoint at 7.0.14 is not this server's: unknown", () => {
      const text = swap(at714(MCPSO), "https://www.hemmabo.com/mcp", "https://elsewhere.example/mcp");
      assertNotGreen(catalog.checkMcpso(page(text), ctx("7.0.14")), "unknown");
    });

    it("the same record under another member than qualityDetails, or outside probe, is not read: unknown", () => {
      assertNotGreen(catalog.checkMcpso(page(swap(at714(MCPSO), "qualityDetails:", "archivedQualityDetails:")), ctx("7.0.14")), "unknown");
      assertNotGreen(catalog.checkMcpso(page(swap(at714(MCPSO), '\\"probe\\"', '\\"previousProbe\\"')), ctx("7.0.14")), "unknown");
    });

    it("previous_qualityDetails is not qualityDetails, nor is any other name that ends the same: unknown", () => {
      // The reviewer's counterexample at fdb3f86, and its neighbours.
      for (const name of ["previous_qualityDetails:", "previousqualityDetails:", "$qualityDetails:", "old.qualityDetails:", "qualityDetails2:", "qualityDetailsOld:"]) {
        const text = swap(at714(MCPSO), "qualityDetails:", name);
        assert.deepEqual(catalog.mcpsoVersions(text), [], name);
        assertNotGreen(catalog.checkMcpso(page(text), ctx("7.0.14")), "unknown");
      }
    });

    for (const [where, wrap] of NOT_CODE) {
      it(`script data inside ${where} is not read: unknown`, () => {
        const text = scriptBodyAs(at714(MCPSO), wrap);
        assert.deepEqual(catalog.mcpsoQualityDetails(text), []);
        assertNotGreen(catalog.checkMcpso(page(text), ctx("7.0.14")), "unknown");
      });
    }

    it("a complete 7.0.14 probe that is only text in a regular expression after return is not read: unknown", () => {
      // The reviewer's consequence at e90603d, built from the fixture's own member text.
      const member = MCPSO.slice(MCPSO.indexOf("qualityDetails:"), MCPSO.indexOf(",sortOrder:0"));
      assert.ok(member.startsWith('qualityDetails:"{'));
      // The member's own text as the pattern of a regular-expression literal. Its backslashes
      // stay as they are on purpose (in a pattern, \" is the character "), so that the text is
      // the very text that was misread as a member at e90603d; only the slashes of the URL,
      // which would end the literal, are written \/. This builds test input; it sanitizes nothing.
      const asRegex = member.replace("7.0.12", "7.0.14").split("/").join("\\/");
      const text = swap(MCPSO, MCPSO.slice(MCPSO.indexOf("<script"), MCPSO.indexOf("</script>")), `<script>function f(){return /${asRegex}/;}`);
      assert.deepEqual(catalog.mcpsoQualityDetails(text), []);
      assertNotGreen(catalog.checkMcpso(page(text), ctx("7.0.14")), "unknown");
    });

    for (const [what, open, close] of NOT_A_SCRIPT) {
      it(`${what}: the script data is not read, unknown`, () => {
        const text = scriptTagsAs(at714(MCPSO), open, close);
        assert.deepEqual(catalog.mcpsoQualityDetails(text), []);
        assertNotGreen(catalog.checkMcpso(page(text), ctx("7.0.14")), "unknown");
      });
    }

    it("an unreadable current record and a complete 7.0.14 record in an archive function that is never called: unknown", () => {
      // The reviewer's practical consequence at 4eda1a0: the row was green from the archive record.
      const open = MCPSO.indexOf(">", MCPSO.indexOf("<script")) + 1;
      const close = MCPSO.indexOf("</script>");
      const current = MCPSO.slice(open, close);
      const unreadable = swap(current, 'qualityDetails:"{', 'qualityDetails:"not json {');
      const archive = `function archivedListing() { ${swap(current, "7.0.12", "7.0.14")} }`;
      const text = `${MCPSO.slice(0, open)}${unreadable};\n${archive}${MCPSO.slice(close)}`;
      assert.equal(catalog.mcpsoQualityDetails(text).length, 1, "only the page's own record is on the path");
      assertNotGreen(catalog.checkMcpso(page(text), ctx("7.0.14")), "unknown");
    });

    it("a stale current record stays stale next to a 7.0.14 record in a function that is never called", () => {
      const open = MCPSO.indexOf(">", MCPSO.indexOf("<script")) + 1;
      const close = MCPSO.indexOf("</script>");
      const current = MCPSO.slice(open, close);
      const text = `${MCPSO.slice(0, open)}${current};\nfunction archivedListing() { ${swap(current, "7.0.12", "7.0.14")} }${MCPSO.slice(close)}`;
      const r = catalog.checkMcpso(page(text), ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.version, "stale");
    });

    it("the record of another listing in the same router data (another slug) is not this server's: unknown", () => {
      const text = swap(at714(MCPSO), 'slug:"hemmabo-mcp-server"', 'slug:"another-mcp-server"');
      assertNotGreen(catalog.checkMcpso(page(text), ctx("7.0.14")), "unknown");
    });

    it("a broken link anywhere on the path from the router gives no version: unknown", () => {
      for (const [from, to] of [
        ["$_TSR.router=", "$_TSR.archivedRouter="],
        ["$_TSR.router=", "$_OLD.router="],
        ["$_TSR.router=", "var router="],
        ["{matches:", "{previousMatches:"],
        ["{l:", "{previousLoaderData:"],
        ["{server:", "{previousServer:"],
        ['slug:"hemmabo-mcp-server"', 'previousSlug:"hemmabo-mcp-server"'],
        ['slug:"hemmabo-mcp-server"', "slug:`hemmabo-mcp-server`"],
        ["qualityDetails:", "[`qualityDetails`]:"],
        ["($R=>", "(async $R=>"],
        ['})($R["tsr"])', "})"],
      ] as const) {
        assertNotGreen(catalog.checkMcpso(page(swap(at714(MCPSO), from, to)), ctx("7.0.14")), "unknown");
      }
    });

    it("a record written twice, or a slug written twice, is unknown", () => {
      const twice = swap(at714(MCPSO), ",sortOrder:0", ',qualityDetails:"{}",sortOrder:0');
      assertNotGreen(catalog.checkMcpso(page(twice), ctx("7.0.14")), "unknown");
      const slugs = swap(at714(MCPSO), 'slug:"hemmabo-mcp-server"', 'slug:"another-mcp-server",slug:"hemmabo-mcp-server"');
      assertNotGreen(catalog.checkMcpso(page(slugs), ctx("7.0.14")), "unknown");
    });

    it("script data that sits only in an HTML comment is not read: unknown", () => {
      assertNotGreen(catalog.checkMcpso(page(scriptInComment(at714(MCPSO))), ctx("7.0.14")), "unknown");
    });

    it("an unrelated serverVersion 7.0.14 elsewhere does not make a stale page current", () => {
      const text = MCPSO.replace("</body>", '<script>var x = {serverVersion:"7.0.14"}; var y = "{\\"serverVersion\\":\\"7.0.14\\"}";</script><!-- serverVersion":"7.0.14" --></body>');
      const r = catalog.checkMcpso(page(text), ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.version, "stale");
    });

    it("an unrelated serverVersion 7.0.12 does not make the row stale when this server's probe is unknown", () => {
      const unbound = swap(MCPSO, '\\"serverName\\":\\"hemmabo-mcp-server\\"', '\\"serverName\\":\\"unrelated-mcp-server\\"');
      const r = catalog.checkMcpso(page(unbound), ctx("7.0.14"));
      assert.equal(r.ok, "unknown");
      assert.equal(r.version, "unknown");
    });

    it("the protocol version in the probe (2025-06-18) is not read as the server version", () => {
      assert.match(MCPSO, /protocolVersion/);
      assert.deepEqual(catalog.mcpsoVersions(MCPSO), ["7.0.12"]);
      const text = swap(MCPSO, '\\"serverVersion\\":\\"7.0.12\\",', "");
      assertNotGreen(catalog.checkMcpso(page(text), ctx("7.0.14")), "unknown");
    });

    it("a current version does not excuse a missing tool", () => {
      const text = swap(at714(MCPSO), "<li><span>vrp_get_verified_stay_offer</span></li>", "");
      const r = catalog.checkMcpso(page(text), ctx("7.0.14"));
      assert.equal(r.ok, false);
      assert.equal(r.tools, false);
      assert.equal(r.version, "current");
    });
  });

  describe("Glama connector page", () => {
    it("lists the tools and states no version: unknown, never at the version", () => {
      const text = `<html><body><ul>${TOOLS.map((n) => `<li>${n}</li>`).join("")}</ul></body></html>`;
      const r = catalog.checkGlamaConnector(page(text), ctx("7.0.14"));
      assert.equal(r.ok, "unknown");
      assert.equal(r.tools, true);
      assert.equal(r.version, "unknown");
    });
  });

  describe("the page: an HTML parser says what a script element is", () => {
    it("scriptElements gives each script element's own type and text, in document order", () => {
      const doc = `<script type="Module">a</script><!-- <script>b</script> --><SCRIPT class=x TYPE='application/json'>c</SCRIPT><scripture>d</scripture><script data-note=" type='text/javascript'" type="application/ld+json">e</script><script>f`;
      assert.deepEqual(catalog.scriptElements(doc), [
        { type: "module", body: "a" },
        { type: "application/json", body: "c" },
        { type: "application/ld+json", body: "e" },
        { type: "", body: "f" },
      ]);
    });

    it("a script's text ends at </script>, also when the text holds a quote or a comment start", () => {
      assert.deepEqual(catalog.scriptElements(`<script>var s = "<!-- x";</script><p>after</p>`), [{ type: "", body: 'var s = "<!-- x";' }]);
    });

    it("the readable text leaves out scripts, styles, noscript, templates and comments, and decodes entities", () => {
      const doc = `<p>one &amp; two</p><script>hidden_a</script><style>hidden_b</style><noscript>hidden_c</noscript><template><p>hidden_d</p></template><!-- hidden_e --><p>three</p>`;
      const text = catalog.visible(doc);
      assert.match(text, /one & two/);
      assert.match(text, /three/);
      for (const hidden of ["hidden_a", "hidden_b", "hidden_c", "hidden_d", "hidden_e"]) assert.equal(text.includes(hidden), false, hidden);
    });
  });

  describe("the bootstrap: the data is read where the page starts itself up, by a named path", () => {
    const html = (body: string, attributes = "") => `<html><body><script${attributes}>${body}</script></body></html>`;
    const CALL = 'window.__reactRouterContext.streamController.enqueue("x")';
    const router = (server: string) => `$_TSR.router=($R=>$R[0]={matches:$R[1]=[$R[2]={l:$R[3]={server:$R[4]=${server}}}]})($R["tsr"]);`;
    const SERVER = '{slug:"hemmabo-mcp-server",qualityDetails:"x"}';

    it("Glama: the call is read as a top-level statement, once per statement, the string as the language decodes it", () => {
      assert.deepEqual(catalog.glamaBootstrapChunks(html(`${CALL};`)), ["x"]);
      assert.deepEqual(catalog.glamaBootstrapChunks(html(`var a = 1; ${CALL}; ${CALL.replace('"x"', '"b\\"c"')}; ${CALL.replace('"x"', "'d\\x41'")};`)), ["x", 'b"c', "dA"]);
    });

    for (const [what, body] of [
      ["inside a function that is declared", `function f(){ ${CALL}; }`],
      ["inside an immediately invoked function", `(function(){ ${CALL}; })();`],
      ["inside a branch", `if (true) { ${CALL}; }`],
      ["as an argument", `log(${CALL});`],
      ["assigned to a variable", `var r = ${CALL};`],
      ["after a comma", `0, ${CALL};`],
      ["after &&", `true && ${CALL};`],
      ["awaited or negated", `void ${CALL}; !${CALL};`],
      ["another receiver", 'streamController.enqueue("x"); self.__reactRouterContext.streamController.enqueue("x"); window.ctx.streamController.enqueue("x"); window.__reactRouterContext.archive.streamController.enqueue("x");'],
      ["another method", 'window.__reactRouterContext.streamController.enqueueLater("x"); window.__reactRouterContext.streamController.close("x");'],
      ["an optional or computed step", 'window.__reactRouterContext.streamController?.enqueue("x"); window.__reactRouterContext.streamController.enqueue?.("x"); window.__reactRouterContext.streamController["enqueue"]("x"); window["__reactRouterContext"].streamController.enqueue("x");'],
      ["two arguments, no argument", 'window.__reactRouterContext.streamController.enqueue("x", 1); window.__reactRouterContext.streamController.enqueue();'],
      ["an argument that is not a string literal", 'window.__reactRouterContext.streamController.enqueue(`x`); window.__reactRouterContext.streamController.enqueue("x"+""); window.__reactRouterContext.streamController.enqueue(x);'],
      ["a new expression", 'new window.__reactRouterContext.streamController.enqueue("x");'],
      ["text in a template literal or a regular expression", "const s = `a ${`" + CALL + "`} b`; function f(){return /window.__reactRouterContext.streamController.enqueue\\(\"x\"\\)/;}"],
    ] as const) {
      it(`Glama: the call ${what} is not the page's bootstrap`, () => {
        assert.deepEqual(catalog.glamaBootstrapChunks(html(body)), []);
      });
    }

    it("mcp.so: the record is read on the path, with or without the serializer's wrappers, with quoted keys, in any match", () => {
      assert.deepEqual(catalog.mcpsoQualityDetails(html(router(SERVER))), ["x"]);
      assert.deepEqual(catalog.mcpsoQualityDetails(html('$_TSR.router=($R=>({matches:[{l:{server:{"slug":"hemmabo-mcp-server","qualityDetails":"y"}}}]}))($R["tsr"]);')), ["y"]);
      assert.deepEqual(
        catalog.mcpsoQualityDetails(html('$_TSR.router=($R=>$R[0]={matches:[{id:"root"},{l:{other:1}},{l:{server:{slug:"hemmabo-mcp-server",qualityDetails:"z"}}}]})($R["tsr"]);')),
        ["z"],
      );
    });

    for (const [what, body] of [
      ["a nested template literal", 'const s = `a ${`qualityDetails:"x"`} b`;'],
      ["a regular expression after return", 'function f(){return /qualityDetails:"x"/;}'],
      ["a bare object with the member, off the path", 'var o = {slug:"hemmabo-mcp-server",qualityDetails:"x"};'],
      ["the whole router inside a declared function", `function unusedExample(){ ${router(SERVER)} }`],
      ["the router assigned to another name", router(SERVER).replace("$_TSR.router=", "$_TSR.routerExample=")],
      ["the router assigned through a computed name", router(SERVER).replace("$_TSR.router=", '$_TSR["router"]=')],
      ["the router under another object", router(SERVER).replace("$_TSR.router=", "archive.$_TSR.router=")],
      ["a compound assignment", router(SERVER).replace("$_TSR.router=", "$_TSR.router||=")],
      ["the arrow function not invoked", '$_TSR.router=$R=>$R[0]={matches:[{l:{server:{slug:"hemmabo-mcp-server",qualityDetails:"x"}}}]};'],
      ["a function expression instead of the arrow", '$_TSR.router=(function($R){return {matches:[{l:{server:{slug:"hemmabo-mcp-server",qualityDetails:"x"}}}]}})($R["tsr"]);'],
      ["an arrow with a block body", '$_TSR.router=($R=>{return {matches:[{l:{server:{slug:"hemmabo-mcp-server",qualityDetails:"x"}}}]}})($R["tsr"]);'],
      ["matches that is not an array", '$_TSR.router=($R=>({matches:{l:{server:{slug:"hemmabo-mcp-server",qualityDetails:"x"}}}}))($R["tsr"]);'],
      ["a server one level deeper", '$_TSR.router=($R=>({matches:[{l:{data:{server:{slug:"hemmabo-mcp-server",qualityDetails:"x"}}}}]}))($R["tsr"]);'],
      ["a server directly in the match", '$_TSR.router=($R=>({matches:[{server:{slug:"hemmabo-mcp-server",qualityDetails:"x"}}]}))($R["tsr"]);'],
      ["a record without slug", router('{qualityDetails:"x"}')],
      ["a record with another slug", router('{slug:"another-mcp-server",qualityDetails:"x"}')],
      ["a slug that is not a string literal", router('{slug:"hemmabo-"+"mcp-server",qualityDetails:"x"}')],
      ["a computed key", router('{slug:"hemmabo-mcp-server",["qualityDetails"]:"x"}')],
      ["a shorthand, a method, a getter", `var qualityDetails = "x"; ${router('{slug:"hemmabo-mcp-server",qualityDetails}')} ${router('{slug:"hemmabo-mcp-server",qualityDetails(){return "x"}}')} ${router('{slug:"hemmabo-mcp-server",get qualityDetails(){return "x"}}')}`],
      ["a spread", router('{slug:"hemmabo-mcp-server",...{qualityDetails:"x"}}')],
      ["a value that is a template literal or a concatenation", `${router('{slug:"hemmabo-mcp-server",qualityDetails:`x`}')} ${router('{slug:"hemmabo-mcp-server",qualityDetails:"x"+""}')}`],
      ["a member written twice", router('{slug:"hemmabo-mcp-server",qualityDetails:"x",qualityDetails:"y"}')],
      ["a similarly named member", router('{slug:"hemmabo-mcp-server",previous_qualityDetails:"x",qualityDetails2:"x",$qualityDetails:"x"}')],
    ] as const) {
      it(`mcp.so: ${what} is not the listing's qualityDetails`, () => {
        assert.deepEqual(catalog.mcpsoQualityDetails(html(body)), []);
      });
    }

    it("a script the parser does not accept contributes nothing; the page's other scripts are still read", () => {
      const doc = `<script>${router(SERVER)} var = ;</script><script>${router('{slug:"hemmabo-mcp-server",qualityDetails:"good"}')}</script>`;
      assert.deepEqual(catalog.mcpsoQualityDetails(doc), ["good"]);
    });

    it("a data block is not JavaScript: only script elements a browser runs are parsed", () => {
      for (const type of ["application/json", "application/ld+json", "text/template", "text/plain", "importmap", "speculationrules"]) {
        assert.deepEqual(catalog.mcpsoQualityDetails(html(router(SERVER), ` type="${type}"`)), [], type);
      }
      assert.deepEqual(catalog.mcpsoQualityDetails(html(router(SERVER), ' type="text/javascript"')), ["x"]);
      assert.deepEqual(catalog.mcpsoQualityDetails(html(router(SERVER), ' type="module"')), ["x"]);
      assert.deepEqual(catalog.mcpsoQualityDetails(html(`export const a = 1; ${router(SERVER)}`)), [], "export is not a classic script");
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
