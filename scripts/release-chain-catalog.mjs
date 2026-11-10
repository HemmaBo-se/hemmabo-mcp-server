/**
 * release-chain-catalog.mjs: how release-chain-measure.mjs reads a catalog page.
 *
 * Pure functions, no network, so the tests in
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
 */

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

/** The page's readable text: scripts and tags dropped, whitespace folded. */
export const visible = (html) => withoutScripts(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// A name counts only as a whole token: `get_verified_stay_offer` (retired) is
// a substring of `vrp_get_verified_stay_offer` (current), and a substring test
// reported the Glama server page and mcp.so as listing the retired name from
// 7.0.5 on, when neither did (measured 2026-10-26: zero whole-token matches).
export const has = (text, needle) =>
  new RegExp(`(?<![A-Za-z0-9_])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`).test(text);
export const missing = (text, names) => names.filter((n) => !has(text, n));
export const present = (text, names) => names.filter((n) => has(text, n));

const SEMVER = "(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)";

/** Every distinct value a pattern captures in the raw page, in order of first appearance. */
function captured(html, pattern) {
  return [...new Set([...html.matchAll(pattern)].map((m) => m[1]))];
}

/**
 * The version the Glama server page states: the `version` of its
 * `latestRelease`, in the page's serialized data as `"version","7.0.12"`
 * (the quotes are backslash-escaped inside a script string).
 */
export function glamaServerVersions(html) {
  return captured(html, new RegExp(`\\\\?"version\\\\?",\\\\?"${SEMVER}\\\\?"`, "g"));
}

/**
 * The version mcp.so states: `serverVersion` in the record of its own
 * connection test, e.g. `\"serverName\":\"hemmabo-mcp-server\",\"serverVersion\":\"7.0.12\"`.
 */
export function mcpsoVersions(html) {
  return captured(html, new RegExp(`serverVersion\\\\?"\\s*:\\s*\\\\?"${SEMVER}\\\\?"`, "g"));
}

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
    ? { state: "unknown", detail: "version not stated on the page" }
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
  return catalogResult({ status, tools, version: versionVerdict(mcpsoVersions(text), version) });
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
