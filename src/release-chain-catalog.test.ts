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
  scriptBodies(html: string): string[];
  scriptElements(html: string): { type: string; body: string }[];
  enqueuedChunks(html: string): string[];
  memberStrings(html: string, name: string): string[];
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
];
/** The reviewer's two reproductions at e90603d, and their neighbours: text that only looks like the member. */
const LOOKS_LIKE_A_MEMBER: [string, string][] = [
  ["a nested template literal", 'const s = `a ${`qualityDetails:"x"`} b`;'],
  ["a regular expression after return", 'function f(){return /qualityDetails:"x"/;}'],
  ["a regular expression after typeof, in a condition, after a brace", 'var a = typeof /qualityDetails:"x"/; if (a) /qualityDetails:"x"/.test(a); {/qualityDetails:"x"/}'],
  ["a regular expression with a class holding a slash", 'var r = /[/]qualityDetails:"x"/;'],
  ["a template literal", 'var s = `qualityDetails:"x"`;'],
  ["a tagged template", 'var s = tag`qualityDetails:"x"`;'],
  ["a template literal three levels deep", 'var s = `${`${`qualityDetails:"x"`}`}`;'],
  ["a string holding a comment end and the member", 'var s = "*/ qualityDetails:\\"x\\"";'],
  ["a block comment holding a string start", '/* " */ var s = 1; /* qualityDetails:"x" */'],
  ["a label and a string statement", 'qualityDetails:"x";'],
  ["a computed key", 'var o = {["qualityDetails"]:"x"};'],
  ["a shorthand and a method", 'var qualityDetails = "x"; var o = {qualityDetails, m(){ return 1; }};'],
  ["a getter", 'var o = {get qualityDetails(){ return "x"; }};'],
  ["a class field", 'class C { qualityDetails = "x"; }'],
  ["an assignment, not an object member", 'var o = {}; o.qualityDetails = "x";'],
  ["a default parameter", 'function f(qualityDetails = "x"){}'],
  ["a member whose value is a template literal", 'var o = {qualityDetails:`x`};'],
  ["a member whose value is a concatenation", 'var o = {qualityDetails:"x"+""};'],
];
/** Text that only looks like the page-data call. */
const LOOKS_LIKE_THE_CALL: [string, string][] = [
  ["a nested template literal", 'const s = `a ${`streamController.enqueue("x")`} b`;'],
  ["a regular expression after return", 'function f(){return /streamController.enqueue("x")/;}'],
  ["an optional call", 'streamController?.enqueue("x"); streamController.enqueue?.("x");'],
  ["a computed property", 'streamController["enqueue"]("x");'],
  ["two arguments, no argument", 'streamController.enqueue("x", 1); streamController.enqueue();'],
  ["a template literal argument", 'streamController.enqueue(`x`);'],
  ["a concatenated argument", 'streamController.enqueue("x"+"");'],
  ["another receiver", 'streamControllers.enqueue("x"); a.streamController.b.enqueue("x"); enqueue("x");'],
  ["a new expression", 'new streamController.enqueue("x");'],
];
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
        assert.deepEqual(catalog.enqueuedChunks(text), []);
        assertNotGreen(catalog.checkGlamaServer(page(text), ctx("7.0.14")), "unknown");
      });
    }

    it("page data that sits only in an HTML comment is not read: unknown", () => {
      const text = scriptInComment(at714(GLAMA));
      assert.deepEqual(catalog.scriptBodies(text), []);
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
        assert.deepEqual(catalog.memberStrings(text, "qualityDetails"), []);
        assertNotGreen(catalog.checkMcpso(page(text), ctx("7.0.14")), "unknown");
      });
    }

    it("a complete 7.0.14 probe that is only text in a regular expression after return is not read: unknown", () => {
      // The reviewer's consequence at e90603d, built from the fixture's own member text.
      const member = MCPSO.slice(MCPSO.indexOf("qualityDetails:"), MCPSO.indexOf(",sortOrder:0"));
      assert.ok(member.startsWith('qualityDetails:"{'));
      const asRegex = member.replace("7.0.12", "7.0.14").replace(/\//g, "\\/");
      const text = swap(MCPSO, MCPSO.slice(MCPSO.indexOf("<script"), MCPSO.indexOf("</script>")), `<script>function f(){return /${asRegex}/;}`);
      assert.deepEqual(catalog.memberStrings(text, "qualityDetails"), []);
      assertNotGreen(catalog.checkMcpso(page(text), ctx("7.0.14")), "unknown");
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

  describe("the outer reading: the syntax tree, not the text", () => {
    const html = (body: string, attributes = "") => `<html><body><script${attributes}>${body}</script></body></html>`;

    for (const [what, body] of LOOKS_LIKE_A_MEMBER) {
      it(`${what} is not a member named qualityDetails`, () => {
        assert.deepEqual(catalog.memberStrings(html(body), "qualityDetails"), []);
      });
    }

    for (const [what, body] of LOOKS_LIKE_THE_CALL) {
      it(`${what} is not the call streamController.enqueue("…")`, () => {
        assert.deepEqual(catalog.enqueuedChunks(html(body)), []);
      });
    }

    it("reads the member where it is one: plain, quoted key, nested, inside a function, inside ${…} of a template", () => {
      assert.deepEqual(catalog.memberStrings(html('var o = {qualityDetails:"a"};'), "qualityDetails"), ["a"]);
      assert.deepEqual(catalog.memberStrings(html('var o = {"qualityDetails":"b"};'), "qualityDetails"), ["b"]);
      assert.deepEqual(catalog.memberStrings(html('x = [{y:{qualityDetails:"c"}}];'), "qualityDetails"), ["c"]);
      assert.deepEqual(catalog.memberStrings(html('function f(){return {qualityDetails:"d"};}'), "qualityDetails"), ["d"]);
      assert.deepEqual(catalog.memberStrings(html('var s = `${ {qualityDetails:"e"}.qualityDetails }`;'), "qualityDetails"), ["e"]);
    });

    it("reads the call where it is one, with the string as the language decodes it", () => {
      assert.deepEqual(catalog.enqueuedChunks(html('streamController.enqueue("a");')), ["a"]);
      assert.deepEqual(catalog.enqueuedChunks(html('window.ctx.streamController.enqueue("b\\"c");')), ['b"c']);
      assert.deepEqual(catalog.enqueuedChunks(html("streamController.enqueue('d\\x41');")), ["dA"]);
    });

    it("a script the parser does not accept contributes nothing; the page's other scripts are still read", () => {
      const page = `<script>var o = {qualityDetails:"bad"}; var = ;</script><script>var p = {qualityDetails:"good"};</script>`;
      assert.deepEqual(catalog.memberStrings(page, "qualityDetails"), ["good"]);
    });

    it("a data block is not JavaScript: application/json and ld+json are not parsed as code", () => {
      for (const type of ["application/json", "application/ld+json", "text/template", "text/plain"]) {
        assert.deepEqual(catalog.memberStrings(html('var o = {qualityDetails:"x"};', ` type="${type}"`), "qualityDetails"), [], type);
      }
      assert.deepEqual(catalog.memberStrings(html('var o = {qualityDetails:"x"};', ' type="text/javascript"'), "qualityDetails"), ["x"]);
      assert.deepEqual(catalog.memberStrings(html('export const o = {qualityDetails:"y"};', ' type="module"'), "qualityDetails"), ["y"]);
      assert.deepEqual(catalog.memberStrings(html('export const o = {qualityDetails:"z"};'), "qualityDetails"), [], "export is not a classic script");
    });

    it("scriptElements gives each script's type and body, and skips scripts inside HTML comments", () => {
      const page = `<script type="Module">a</script><!-- <script>b</script> --><SCRIPT class=x TYPE='application/json'>c</SCRIPT><script>d`;
      assert.deepEqual(catalog.scriptElements(page), [
        { type: "module", body: "a" },
        { type: "application/json", body: "c" },
        { type: "", body: "d" },
      ]);
    });
  });

  describe("memberStrings: the member by its exact name", () => {
    const html = (body: string) => `<html><body><script>${body}</script></body></html>`;

    it("reads a member whose name holds a $ and nothing that merely resembles it", () => {
      assert.deepEqual(catalog.memberStrings(html('x={$data:"a",xdata:"b",$data2:"c"}'), "$data"), ["a"]);
      assert.deepEqual(catalog.memberStrings(html('x={a$b:"1",ab:"2",aXb:"3"}'), "a$b"), ["1"]);
    });

    it("a name that is not an identifier reads nothing, whatever it would mean as a pattern", () => {
      for (const name of ["quality.Details", "qualityDetails|probe", "quality\\Details", ".*", "", "a b", "1abc"]) {
        assert.deepEqual(catalog.memberStrings(html('x={qualityDetails:"a",probe:"b",qualityXDetails:"c"}'), name), [], JSON.stringify(name));
      }
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
