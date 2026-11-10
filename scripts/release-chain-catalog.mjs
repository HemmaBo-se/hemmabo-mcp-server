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
 * A version counts only when it is bound to this server's own record, and
 * every step to that record is a named step from a root, never a search:
 *
 *   the page       an established HTML parser (parse5) says which elements
 *                  are script elements and what their attributes are
 *   the script     an established JavaScript parser (acorn) gives each
 *                  script's syntax tree; a script it rejects contributes
 *                  nothing
 *   the bootstrap  the page data is read only where the page starts itself
 *                  up: on Glama, a top-level statement that is the call
 *                  window.__reactRouterContext.streamController.enqueue("…");
 *                  on mcp.so, the top-level assignment to $_TSR.router and,
 *                  inside it, matches → l → server
 *   the record     on Glama, loaderData → a route → mcpServer (this slug) →
 *                  repository (this repository) → latestRelease.version;
 *                  on mcp.so, the server record with this slug, its
 *                  qualityDetails, and in it the probe that names this server
 *                  and its endpoint → serverVersion
 *
 * A version anywhere else is not read, and the reading is then unknown:
 * another release field, a record the page's server does not point to,
 * another server, a similarly named member, a comment, the inside of a
 * string, a template literal or a regular expression, a function that is
 * merely declared, a script element that is not JavaScript.
 *
 * Found by the independent reviewer, round by round. 13b9fc7: the version was
 * matched as text across the whole page. fdb3f86: any record in Glama's array
 * counted; `previous_qualityDetails:` matched; a commented-out script body
 * was read. e90603d: a hand-written lexer let a nested template literal and a
 * regular expression after `return` through as code. 4eda1a0: a hand-written
 * scan of the HTML took text inside another attribute for the script's type
 * and took <scripture> for a script; and the syntax tree was searched whole,
 * so a complete record inside a function that is never called counted.
 * a339f1a: a later entry in an object literal (a spread, a computed key, a
 * getter) could replace a member that had been read; a second assignment to
 * the router was ignored. c09fec4: a direct write to `$_TSR` after the
 * start-up statement was seen only as an assignment expression, and the
 * holder was not recognised under a quoted key; a declaration, `delete`,
 * `++` and a `for` variable passed.
 * The lessons: do not write a parser; do not search where a path can be
 * followed; and a second mention of the router, a direct write to its holder
 * or an uncertain entry in an object on the path makes the answer unknown.
 * That is not everything that could change the value: a change through
 * another name for the same object or through a call is not modelled.
 */
import { parse as parseScript } from "acorn";
import { parse as parseHtml } from "parse5";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const isVersion = (value) => typeof value === "string" && SEMVER.test(value);

/** The names a version must be bound to before it counts as this server's. */
export const GLAMA_REPOSITORY = "HemmaBo-se/hemmabo-mcp-server";
export const GLAMA_SLUG = "hemmabo-mcp-server";
export const MCPSO_SLUG = "hemmabo-mcp-server";
export const MCPSO_SERVER_NAME = "hemmabo-mcp-server";
export const MCPSO_ENDPOINT = "https://www.hemmabo.com/mcp";

// ── the page ────────────────────────────────────────────────────────────────

/** Every node of a parsed HTML document, depth first, with the names of the elements it sits in. */
function* htmlNodes(node, inside = []) {
  yield [node, inside];
  const here = node.tagName ? [...inside, node.tagName] : inside;
  for (const child of node.childNodes ?? []) yield* htmlNodes(child, here);
}

/**
 * The page's script elements, in document order, as the HTML parser sees them:
 * the value of the element's own `type` attribute (lowercased, "" when
 * absent) and the element's text. An element that merely starts with the same
 * letters (<scripture>), text inside another attribute, a script inside a
 * comment or inside a <template>, are not script elements.
 */
export function scriptElements(html) {
  const elements = [];
  for (const [node] of htmlNodes(parseHtml(html))) {
    if (node.tagName !== "script" || node.namespaceURI !== HTML_NAMESPACE) continue;
    const type = (node.attrs ?? []).find((attribute) => attribute.name === "type");
    const body = (node.childNodes ?? []).map((child) => (child.nodeName === "#text" ? child.value : "")).join("");
    elements.push({ type: (type ? type.value : "").trim().toLowerCase(), body });
  }
  return elements;
}

/**
 * The page's readable text: the text nodes of the parsed document that are
 * not inside a script, a style, a noscript or a template, whitespace folded.
 * Comments are not text. A catalog page's script data names every tool it has
 * ever known; only what a reader sees counts for the tool list.
 */
export function visible(html) {
  const hidden = new Set(["script", "style", "noscript", "template"]);
  let text = "";
  for (const [node, inside] of htmlNodes(parseHtml(html))) {
    if (node.nodeName !== "#text" || inside.some((name) => hidden.has(name))) continue;
    text += ` ${node.value}`;
  }
  return text.replace(/\s+/g, " ");
}

// ── the script ──────────────────────────────────────────────────────────────

/** The script types a browser runs as JavaScript; a data block (application/json, ld+json) is not code. */
const CLASSIC = new Set(["", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"]);

/**
 * The syntax trees of the page's JavaScript, one per script element. A body
 * the parser does not accept as a whole program contributes nothing: a script
 * that cannot be read with certainty cannot support a verified version.
 * Nothing is executed.
 */
export function scriptPrograms(html) {
  const programs = [];
  for (const { type, body } of scriptElements(html)) {
    const sourceType = type === "module" ? "module" : CLASSIC.has(type) ? "script" : null;
    if (sourceType === null) continue;
    try {
      programs.push(parseScript(body, { ecmaVersion: "latest", sourceType }));
    } catch {
      // not a program the parser accepts: not read
    }
  }
  return programs;
}

/** A string literal's value; undefined for a template, a regular expression, a number, anything else. */
const stringLiteral = (node) => (node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined);
/** A name written out in the source: an identifier or, for a property key, a quoted string; never computed. */
const writtenName = (node, computed) => (computed ? undefined : node?.type === "Identifier" ? node.name : stringLiteral(node));

/** `a.b.c` as ["a", "b", "c"] when the expression is exactly such a chain of plain names; otherwise undefined. */
function memberChain(node) {
  const names = [];
  let current = node;
  while (current?.type === "MemberExpression") {
    if (current.optional || current.computed || current.property?.type !== "Identifier") return undefined;
    names.unshift(current.property.name);
    current = current.object;
  }
  if (current?.type !== "Identifier") return undefined;
  names.unshift(current.name);
  return names;
}
const sameChain = (node, names) => {
  const chain = memberChain(node);
  return chain !== undefined && chain.length === names.length && chain.every((name, i) => name === names[i]);
};

/** The program's top-level expression statements: what the script does when it runs, nothing it merely declares. */
const topLevelExpressions = (program) =>
  program.body.filter((statement) => statement.type === "ExpressionStatement").map((statement) => statement.expression);

// ── Glama ───────────────────────────────────────────────────────────────────

/**
 * The page data Glama's page starts up with: the string argument of each
 * top-level statement that is exactly
 * `window.__reactRouterContext.streamController.enqueue("…")`. The same call
 * inside a function, a condition or any other expression is not the page's
 * bootstrap and is not read.
 */
export function glamaBootstrapChunks(html) {
  const out = [];
  for (const program of scriptPrograms(html)) {
    for (const expression of topLevelExpressions(program)) {
      if (expression.type !== "CallExpression" || expression.optional || expression.arguments.length !== 1) continue;
      if (!sameChain(expression.callee, ["window", "__reactRouterContext", "streamController", "enqueue"])) continue;
      const value = stringLiteral(expression.arguments[0]);
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
 * no entry is read because it merely exists in the array. A record the page's
 * server does not point to, a `version` under another member
 * (`archivedRelease`), another repository, or a broken link anywhere in the
 * chain, gives no version. So does a second page-data table on the page.
 */
export function glamaServerVersions(html) {
  // The chunks that are a page-data table: a JSON array whose root names `loaderData`.
  // A stream may carry further chunks that are not tables; those are not page data.
  const tables = [];
  for (const chunk of glamaBootstrapChunks(html)) {
    let table;
    try {
      table = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (!Array.isArray(table) || !isRecord(table[0])) continue;
    const namesLoaderData = Object.keys(table[0]).some((key) => /^_\d+$/.test(key) && table[Number(key.slice(1))] === "loaderData");
    if (namesLoaderData) tables.push(table);
  }
  // One table. A second one, whatever it holds, means the first is no longer
  // known to be what the page ends up with: unknown.
  if (tables.length !== 1) return [];
  const found = [];
  for (const table of tables) {
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

// ── mcp.so ──────────────────────────────────────────────────────────────────

/**
 * The value an expression in mcp.so's serialized router data stands for: the
 * serializer writes `$R[7]={…}`, an assignment whose value is its right side.
 */
function assigned(node) {
  let current = node;
  while (current?.type === "AssignmentExpression" && current.operator === "=") current = current.right;
  return current;
}

/**
 * The value of the member named `name`, exactly, in an object literal.
 *
 * An object literal says what a member is only when nothing in it can
 * replace that member unseen. So, in this order:
 *  1. A spread (`...x`) or a computed key (`[k]: v`) anywhere in the object
 *     makes every member of it uncertain: undefined.
 *  2. Every entry that spells `name` is counted, whatever its form (a plain
 *     property, a shorthand, a method, a getter, a setter). Not exactly one:
 *     undefined. A later entry replaces an earlier one, so two are never read
 *     as the first.
 *  3. The one entry must be a plain property (`name: value`): otherwise
 *     undefined.
 */
function property(object, name) {
  if (object?.type !== "ObjectExpression") return undefined;
  if (object.properties.some((entry) => entry.type !== "Property" || entry.computed)) return undefined;
  const hits = object.properties.filter((entry) => writtenName(entry.key, false) === name);
  if (hits.length !== 1) return undefined;
  const [entry] = hits;
  if (entry.kind !== "init" || entry.method || entry.shorthand) return undefined;
  return assigned(entry.value);
}

/** Every node of a syntax tree, depth first. */
function* syntaxNodes(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) yield* syntaxNodes(child);
    return;
  }
  if (typeof node.type === "string") yield node;
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (value && typeof value === "object") yield* syntaxNodes(value);
  }
}

/** A node without the wrapper an optional chain puts around it (`a?.b`). */
const unchained = (node) => (node?.type === "ChainExpression" ? node.expression : node);

/**
 * `$_TSR` as a page's scripts can name it directly: the bare name, or the
 * name as a member of another object, written plainly (`self.$_TSR`) or as a
 * quoted key (`self["$_TSR"]`).
 */
const isRouterHolder = (given) => {
  const node = unchained(given);
  if (node?.type === "Identifier") return node.name === "$_TSR";
  if (node?.type !== "MemberExpression") return false;
  return node.computed ? stringLiteral(node.property) === "$_TSR" : node.property?.type === "Identifier" && node.property.name === "$_TSR";
};

/** A member access that is, or could be, the router: `$_TSR.router`, `$_TSR["router"]`, `$_TSR[anything]`. */
const mentionsRouter = (node) =>
  node?.type === "MemberExpression" &&
  isRouterHolder(node.object) &&
  (node.computed ? stringLiteral(node.property) === undefined || node.property.value === "router" : node.property?.type === "Identifier" && node.property.name === "router");

/** The targets a binding or assignment pattern writes to, through any destructuring. */
function* assignmentTargets(pattern) {
  if (!pattern) return;
  if (pattern.type === "ObjectPattern") for (const entry of pattern.properties) yield* assignmentTargets(entry.type === "RestElement" ? entry.argument : entry.value);
  else if (pattern.type === "ArrayPattern") for (const element of pattern.elements) yield* assignmentTargets(element);
  else if (pattern.type === "AssignmentPattern") yield* assignmentTargets(pattern.left);
  else if (pattern.type === "RestElement") yield* assignmentTargets(pattern.argument);
  else yield pattern;
}

/**
 * What a node writes to directly, in each form the language has for it: an
 * assignment (any operator), a declaration (`var`, `let`, `const`, a function,
 * a class), `++`/`--`, `delete`, and the variable of a `for … in`/`for … of`.
 */
function* writeTargets(node) {
  if (node.type === "AssignmentExpression") yield* assignmentTargets(node.left);
  else if (node.type === "VariableDeclarator") yield* assignmentTargets(node.id);
  else if (node.type === "UpdateExpression") yield node.argument;
  else if (node.type === "UnaryExpression" && node.operator === "delete") yield node.argument;
  else if ((node.type === "ForInStatement" || node.type === "ForOfStatement") && node.left.type !== "VariableDeclaration") yield* assignmentTargets(node.left);
  else if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) yield node.id;
}

const writesHolder = (node) => [...writeTargets(node)].some(isRouterHolder);

/**
 * The one statement that starts mcp.so's router, when no script on the page
 * names the router a second time or writes directly to its holder afterwards;
 * otherwise undefined.
 *
 * Decided before anything is read from it:
 *  - the page's scripts mention the router (`$_TSR.router`, also through
 *    `self.$_TSR`, a quoted key or a computed key) exactly once, and that
 *    mention is the left side of a top-level `$_TSR.router = …` statement. A
 *    second mention, wherever it stands and whatever it does (a second
 *    assignment, a write under the router, a mere read), is unknown. That is
 *    stricter than needed for a read, on purpose;
 *  - `$_TSR` itself is written, in any of the direct forms of writeTargets,
 *    only by its definition: a top-level assignment or declaration that
 *    comes before that statement, and what stands inside that definition
 *    (the real page's definition deletes `self.$_TSR` in one of its own
 *    methods). A direct write to it afterwards, or in a function or a branch
 *    of its own, could replace the router: unknown.
 *
 * Not modelled: a change through another name for the same object or through
 * a call (`const t = $_TSR; t.router = {}`, `Object.assign($_TSR, {router})`,
 * `self[key] = {}`). The reading is static; such a page reads as its
 * start-up statement says.
 */
function routerBootstrap(programs) {
  let mentions = 0;
  let bootstrap;
  const definitions = [];
  const writes = [];
  programs.forEach((program, index) => {
    for (const statement of program.body) {
      const defines =
        (statement.type === "ExpressionStatement" && statement.expression.type === "AssignmentExpression" && writesHolder(statement.expression)) ||
        (statement.type === "VariableDeclaration" && statement.declarations.some(writesHolder));
      if (defines) definitions.push({ index, start: statement.start, end: statement.end });
      const expression = statement.type === "ExpressionStatement" ? statement.expression : undefined;
      if (expression?.type === "AssignmentExpression" && expression.operator === "=" && sameChain(expression.left, ["$_TSR", "router"])) bootstrap = { index, node: expression };
    }
    for (const node of syntaxNodes(program)) {
      if (mentionsRouter(node)) mentions += 1;
      if (writesHolder(node)) writes.push({ index, start: node.start, end: node.end });
    }
  });
  if (mentions !== 1 || bootstrap === undefined) return undefined;
  const before = (range) => range.index < bootstrap.index || (range.index === bootstrap.index && range.end <= bootstrap.node.start);
  const within = (write) => definitions.some((definition) => before(definition) && definition.index === write.index && definition.start <= write.start && write.end <= definition.end);
  if (!writes.every(within)) return undefined;
  return bootstrap.node;
}

/**
 * The `qualityDetails` strings of the listing mcp.so's page is about. The
 * page starts its router with one top-level statement,
 * `$_TSR.router = ($R => $R[0] = {…, matches: [… {l: {server: {…}}} …]})(…)`.
 * From that statement the path is followed by exact names: the immediately
 * invoked arrow function's value → `matches` → each match → `l` → `server`,
 * whose `slug` is hemmabo-mcp-server → `qualityDetails`, a string literal.
 * The same members anywhere else (a function that is declared and never
 * called, another statement, another server's record) are not on the path.
 *
 * Nothing is read when the page's scripts mention the router more than once,
 * or write directly to `$_TSR` outside its definition before the router is
 * started; when an
 * object on the path holds a spread or a computed key, or spells a member
 * twice in any form; when the list of matches holds a spread or a hole; when
 * two records carry this listing's slug.
 */
export function mcpsoQualityDetails(html) {
  // Decided before anything is read: one mention of the router, no direct write to its holder afterwards.
  const expression = routerBootstrap(scriptPrograms(html));
  if (expression === undefined) return [];
  const call = expression.right;
  if (call?.type !== "CallExpression" || call.optional) return [];
  const builder = call.callee;
  if (builder?.type !== "ArrowFunctionExpression" || builder.async || !builder.expression) return [];
  const matches = property(assigned(builder.body), "matches");
  if (matches?.type !== "ArrayExpression") return [];
  // A hole or a spread in the list of matches hides what the list holds.
  if (matches.elements.some((element) => element === null || element.type === "SpreadElement")) return [];
  const records = [];
  for (const element of matches.elements) {
    const server = property(property(assigned(element), "l"), "server");
    if (stringLiteral(property(server, "slug")) === MCPSO_SLUG) records.push(server);
  }
  // One record for this listing. Two, also when only one of them is readable, is unknown.
  if (records.length !== 1) return [];
  const value = stringLiteral(property(records[0], "qualityDetails"));
  return value === undefined ? [] : [value];
}

/**
 * The version mcp.so states for this server: `probe.serverVersion` in the
 * listing's `qualityDetails`, the record of mcp.so's own connection test,
 * when that probe names this server (`serverName`) and its endpoint (`url`).
 * `qualityDetails` is a JSON string, decoded and read by exact member name.
 */
export function mcpsoProbes(html) {
  const probes = [];
  for (const text of mcpsoQualityDetails(html)) {
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

// ── the three readings ──────────────────────────────────────────────────────

/** A string as a literal in a regular expression: every metacharacter escaped, the backslash included. */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A name counts only as a whole token: `get_verified_stay_offer` (retired) is
// a substring of `vrp_get_verified_stay_offer` (current), and a substring test
// reported the Glama server page and mcp.so as listing the retired name from
// 7.0.5 on, when neither did (measured 2026-10-26: zero whole-token matches).
export const has = (text, needle) => new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(needle)}(?![A-Za-z0-9_])`).test(text);
export const missing = (text, names) => names.filter((n) => !has(text, n));
export const present = (text, names) => names.filter((n) => has(text, n));

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
