/**
 * release-chain-catalog.mjs: how release-chain-measure.mjs reads a catalog page.
 *
 * Functions without network or side effects, so the tests in
 * src/release-chain-catalog.test.ts can run them on saved page excerpts.
 *
 * A catalog page answers three separate questions, and each is reported on its
 * own (found 2026-11-10 at 7.0.14: the Glama server page and mcp.so both
 * listed all six tools while their own data said 7.0.12, and the row was
 * green because only the tool names were compared):
 *
 *   reachable  the page answered HTTP 200
 *   tools      the page lists the tools production lists, and no retired name
 *   version    the version the page itself states is the version measured
 *
 * The row is at the version only when all three hold. A page that states an
 * older version is stale. A page that states no version, or several, is
 * unknown: it is never counted as at the version.
 *
 * A version counts only when it is bound to this server's own record: on
 * Glama, the chain from the page data's root to the page's own `mcpServer`,
 * its `repository` (HemmaBo-se/hemmabo-mcp-server) and that repository's
 * `latestRelease.version`; on mcp.so, `probe.serverVersion` of the probe that
 * names this server and its endpoint, in the member `qualityDetails`. The
 * outer reading is the syntax tree an established JavaScript parser (acorn)
 * gives for each script: the call and the member are found as nodes of that
 * tree, by exact name. A script the parser does not accept contributes
 * nothing. A version anywhere else
 * (another release field, a record the page's server does not point to,
 * another server, a similarly named member, an HTML or JavaScript comment,
 * the inside of a string, a template literal or a regular expression) is not
 * read, and the reading is then unknown.
 * Found by the independent reviewer in three rounds: at 13b9fc7 the version
 * was matched as text across the whole page; at fdb3f86 any record in Glama's
 * array counted, `previous_qualityDetails:` matched, and a script body inside
 * a JavaScript comment was read; at e90603d a hand-written lexer let a nested
 * template literal and a regular expression after `return` through as code.
 * The lexer is gone: telling code from text in JavaScript is the parser's job.
 */
import { parse } from "acorn";

/**
 * The page without its script bodies: a catalog page's script data names
 * every tool it has ever known, and only the readable text counts. A scan,
 * not a regex, so any case and any spacing of the tags is handled. The
 * result is measured, never rendered or executed.
 */
export function withoutScripts(html) {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const open = lower.indexOf("<script", i);
    if (open === -1) return out + html.slice(i);
    out += html.slice(i, open);
    const close = lower.indexOf("</script", open);
    if (close === -1) return out;
    const end = lower.indexOf(">", close);
    i = end === -1 ? lower.length : end + 1;
  }
}

/** The page's readable text: scripts, comments and tags dropped, whitespace folded. */
export const visible = (html) => withoutScripts(html).replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// A name counts only as a whole token: `get_verified_stay_offer` (retired) is
// a substring of `vrp_get_verified_stay_offer` (current), and a substring test
// reported the Glama server page and mcp.so as listing the retired name from
// 7.0.5 on, when neither did (measured 2026-10-26: zero whole-token matches).
/** A string as a literal in a regular expression: every metacharacter escaped, the backslash included. */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const has = (text, needle) => new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(needle)}(?![A-Za-z0-9_])`).test(text);
export const missing = (text, names) => names.filter((n) => !has(text, n));
export const present = (text, names) => names.filter((n) => has(text, n));

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const isVersion = (value) => typeof value === "string" && SEMVER.test(value);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The names a version must be bound to before it counts as this server's. */
export const GLAMA_REPOSITORY = "HemmaBo-se/hemmabo-mcp-server";
export const GLAMA_SLUG = "hemmabo-mcp-server";
export const MCPSO_SERVER_NAME = "hemmabo-mcp-server";
export const MCPSO_ENDPOINT = "https://www.hemmabo.com/mcp";

/**
 * The page's <script> elements, in order: the value of the `type` attribute
 * (lowercased, "" when absent) and the body. HTML comments outside a script
 * are skipped whole, so a fragment that only sits in a comment is never read.
 * A scan, not a regex; the bodies are parsed as data below, never executed.
 */
export function scriptElements(html) {
  const lower = html.toLowerCase();
  const elements = [];
  let i = 0;
  for (;;) {
    const comment = lower.indexOf("<!--", i);
    const script = lower.indexOf("<script", i);
    if (script === -1) return elements;
    if (comment !== -1 && comment < script) {
      const end = lower.indexOf("-->", comment + 4);
      if (end === -1) return elements;
      i = end + 3;
      continue;
    }
    const open = lower.indexOf(">", script);
    if (open === -1) return elements;
    const attributes = html.slice(script + "<script".length, open);
    const type = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attributes);
    const close = lower.indexOf("</script", open);
    elements.push({
      type: (type ? type[1] ?? type[2] ?? type[3] : "").trim().toLowerCase(),
      body: html.slice(open + 1, close === -1 ? html.length : close),
    });
    if (close === -1) return elements;
    i = close + 8;
  }
}

export const scriptBodies = (html) => scriptElements(html).map((element) => element.body);

/** The script types a browser runs as JavaScript; a data block (application/json, ld+json) is not code. */
const CLASSIC = new Set(["", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"]);

/**
 * The syntax trees of the page's JavaScript, one per script element, from an
 * established parser (acorn). A body that the parser does not accept as a
 * whole program contributes nothing: a script that cannot be read with
 * certainty cannot support a verified version. Nothing is executed.
 */
export function scriptPrograms(html) {
  const programs = [];
  for (const { type, body } of scriptElements(html)) {
    const sourceType = type === "module" ? "module" : CLASSIC.has(type) ? "script" : null;
    if (sourceType === null) continue;
    try {
      programs.push(parse(body, { ecmaVersion: "latest", sourceType }));
    } catch {
      // not a program the parser accepts: not read
    }
  }
  return programs;
}

/** Every node of a syntax tree, depth first. */
function* nodes(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) yield* nodes(child);
    return;
  }
  if (typeof node.type === "string") yield node;
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    if (value && typeof value === "object") yield* nodes(value);
  }
}

/** A string literal's value; undefined for a template, a regular expression, a number, anything else. */
const stringLiteral = (node) => (node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined);
/** A property name written out in the source: an identifier or a quoted string, never a computed expression. */
const writtenName = (node, computed) =>
  computed ? undefined : node?.type === "Identifier" ? node.name : stringLiteral(node);

/**
 * The string literals that are, in the page's JavaScript, the single argument
 * of a call written `streamController.enqueue("…")` or
 * `<anything>.streamController.enqueue("…")`: a call expression in the
 * syntax tree with exactly those two names. Text in a comment, in a string, in
 * a template literal or in a regular expression is not a call.
 */
export function enqueuedChunks(html) {
  const out = [];
  for (const program of scriptPrograms(html)) {
    for (const node of nodes(program)) {
      if (node.type !== "CallExpression" || node.optional || node.arguments.length !== 1) continue;
      const callee = node.callee;
      if (callee?.type !== "MemberExpression" || callee.optional || writtenName(callee.property, callee.computed) !== "enqueue") continue;
      const controller = callee.object;
      const name =
        controller?.type === "Identifier"
          ? controller.name
          : controller?.type === "MemberExpression" && !controller.optional
            ? writtenName(controller.property, controller.computed)
            : undefined;
      if (name !== "streamController") continue;
      const value = stringLiteral(node.arguments[0]);
      if (value !== undefined) out.push(value);
    }
  }
  return out;
}

/**
 * The string literals that are, in the page's JavaScript, the value of an
 * object-literal member named exactly `name` (`{ name: "…" }`): a property in
 * the syntax tree, not shorthand, not a method, not computed.
 * `previous_qualityDetails` is not `qualityDetails`, and the same text in a
 * comment, a string, a template literal or a regular expression is not a
 * member.
 */
export function memberStrings(html, name) {
  if (typeof name !== "string" || name === "") return [];
  const out = [];
  for (const program of scriptPrograms(html)) {
    for (const node of nodes(program)) {
      if (node.type !== "Property" || node.kind !== "init" || node.method || node.shorthand) continue;
      if (writtenName(node.key, node.computed) !== name) continue;
      const value = stringLiteral(node.value);
      if (value !== undefined) out.push(value);
    }
  }
  return out;
}

/**
 * The version the Glama server page states for the server the page is about:
 * from the root of the page data, `loaderData` → a route → `mcpServer` (whose
 * `slug` is hemmabo-mcp-server) → `repository` → `latestRelease.version`,
 * where that repository's `githubRepository.fullName` is
 * HemmaBo-se/hemmabo-mcp-server.
 *
 * Glama serializes its page data as one flat JSON array (turbo-stream): an
 * object is `{"_<index of the key string>": <index of the value>}`. The array
 * is decoded and the chain is followed from the root by exact member names;
 * nothing is matched as text and no entry is read because it merely exists in
 * the array. A record the page's server does not point to, a `version` under
 * another member (`archivedRelease`), another repository, or a broken link
 * anywhere in the chain, gives no version.
 */
export function glamaServerVersions(html) {
  const found = [];
  for (const chunk of enqueuedChunks(html)) {
    let table;
    try {
      table = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (!Array.isArray(table)) continue;
    const at = (ref) => (Number.isInteger(ref) && ref >= 0 ? table[ref] : undefined);
    // The members of a serialized object as [name, value] pairs.
    const members = (object) =>
      isRecord(object)
        ? Object.entries(object)
            .filter(([key]) => /^_\d+$/.test(key))
            .map(([key, ref]) => [table[Number(key.slice(1))], at(ref)])
        : [];
    // The value of the member named `name`, exactly; undefined when absent, or when two
    // different key entries of the array both spell that name. (Two identical keys in
    // the raw JSON text are not seen here: JSON.parse has already kept only the last.)
    const member = (object, name) => {
      const hits = members(object).filter(([key]) => key === name);
      return hits.length === 1 ? hits[0][1] : undefined;
    };
    const loaderData = member(table[0], "loaderData");
    for (const [, route] of members(loaderData)) {
      const server = member(route, "mcpServer");
      if (member(server, "slug") !== GLAMA_SLUG) continue;
      const repository = member(server, "repository");
      if (member(member(repository, "githubRepository"), "fullName") !== GLAMA_REPOSITORY) continue;
      const version = member(member(repository, "latestRelease"), "version");
      if (isVersion(version)) found.push(version);
    }
  }
  return [...new Set(found)];
}

/**
 * The version mcp.so states for this server: `probe.serverVersion` in the
 * listing's `qualityDetails`, the record of mcp.so's own connection test,
 * when that probe names this server (`serverName`) and its endpoint (`url`).
 * `qualityDetails` is read as an object member in the syntax tree of the
 * page's JavaScript, by its exact name; its value is a JSON string, decoded
 * and read by exact member name. So `previous_qualityDetails`,
 * `previous_serverVersion`, another server's probe, or the same text in a
 * comment, a string, a template literal or a regular expression, is not read.
 */
export function mcpsoProbes(html) {
  const probes = [];
  for (const text of memberStrings(html, "qualityDetails")) {
    let details;
    try {
      details = JSON.parse(text);
    } catch {
      continue;
    }
    const probe = isRecord(details) && Object.hasOwn(details, "probe") ? details.probe : undefined;
    if (!isRecord(probe)) continue;
    if (probe.serverName !== MCPSO_SERVER_NAME || probe.url !== MCPSO_ENDPOINT) continue;
    if (!Object.hasOwn(probe, "serverVersion") || !isVersion(probe.serverVersion)) continue;
    probes.push({ version: probe.serverVersion, checkedAt: typeof probe.checkedAt === "string" ? probe.checkedAt : null });
  }
  return probes;
}

export const mcpsoVersions = (html) => [...new Set(mcpsoProbes(html).map((p) => p.version))];

/**
 * current: the page states exactly the wanted version.
 * stale:   the page states exactly one version, and it is another one.
 * unknown: the page states no version, or more than one. Never "current".
 */
export function versionVerdict(found, wanted) {
  if (found.length === 1) {
    return found[0] === wanted
      ? { state: "current", detail: `version ${found[0]}` }
      : { state: "stale", detail: `version ${found[0]}, not ${wanted}` };
  }
  return found.length === 0
    ? { state: "unknown", detail: "no version found for this server in the page's data" }
    : { state: "unknown", detail: `version unclear, the page states ${found.join(" and ")}` };
}

/**
 * One catalog row from its three readings. `ok` is true only when the page is
 * reachable, its tools are right and its stated version is the wanted one;
 * "unknown" when reachable and right on tools but silent on the version;
 * false otherwise.
 */
export function catalogResult({ status, tools, version }) {
  const reachable = status === 200;
  if (!reachable) {
    return { ok: false, reachable, tools: null, version: "unknown", detail: `HTTP ${status}: not reachable; tools and version not read` };
  }
  const ok = !tools.ok || version.state === "stale" ? false : version.state === "current" ? true : "unknown";
  return { ok, reachable, tools: tools.ok, version: version.state, detail: `reachable; tools: ${tools.detail}; ${version.detail}` };
}

function toolsReading(text, toolNames, retiredNames) {
  const gone = missing(text, toolNames);
  const old = present(text, retiredNames);
  return {
    ok: gone.length === 0 && old.length === 0,
    detail: `${gone.length ? `missing ${gone.join(", ")}` : "all listed"}${old.length ? `, retired names listed: ${old.join(", ")}` : ""}`,
  };
}

/** The Glama server page: the tool list between «Available Tools» and «Tool Schema Changelog», and latestRelease's version. */
export function checkGlamaServer({ status, text }, { toolNames, retiredNames, version }) {
  const page = visible(text);
  const from = page.indexOf("Available Tools");
  const until = from === -1 ? -1 : page.indexOf("Tool Schema Changelog", from);
  const list = from === -1 ? "" : page.slice(from, until === -1 ? from + 6000 : until);
  const tools = from === -1 ? { ok: false, detail: "no tool list" } : toolsReading(list, toolNames, retiredNames);
  return catalogResult({ status, tools, version: versionVerdict(glamaServerVersions(text), version) });
}

/** mcp.so: the tool names in the readable page, and serverVersion from its connection test. */
export function checkMcpso({ status, text }, { toolNames, retiredNames, version }) {
  const tools = toolsReading(visible(text), toolNames, retiredNames);
  const verdict = versionVerdict(mcpsoVersions(text), version);
  // When mcp.so last tested the server: a stale version there is the date of its probe.
  const probed = mcpsoProbes(text).map((p) => p.checkedAt).filter(Boolean);
  const when = verdict.state !== "unknown" && probed.length === 1 ? ` (mcp.so's own probe of ${probed[0]})` : "";
  return catalogResult({ status, tools, version: { ...verdict, detail: verdict.detail + when } });
}

/**
 * The Glama connector page: it lists tools and states no version of its own,
 * so its version is unknown, never current. Its changelog records the 6.0.0
 * rename, so retired names are expected there and are not counted.
 */
export function checkGlamaConnector({ status, text }, { toolNames }) {
  const tools = toolsReading(visible(text), toolNames, []);
  return catalogResult({ status, tools, version: { state: "unknown", detail: "the page states no version" } });
}
