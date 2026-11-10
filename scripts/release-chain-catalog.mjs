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
 *
 * A version counts only when it is bound to this server's own record: on
 * Glama, `latestRelease.version` of the repository HemmaBo-se/hemmabo-mcp-server;
 * on mcp.so, `probe.serverVersion` of the probe that names this server and
 * its endpoint. A version anywhere else on the page (another release field,
 * another server, a similarly named member, an HTML comment) is not read, and
 * the reading is then unknown. Found by the independent reviewer at 13b9fc7,
 * where the version was matched as text across the whole page.
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

/** The page's readable text: scripts, comments and tags dropped, whitespace folded. */
export const visible = (html) => withoutScripts(html).replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// A name counts only as a whole token: `get_verified_stay_offer` (retired) is
// a substring of `vrp_get_verified_stay_offer` (current), and a substring test
// reported the Glama server page and mcp.so as listing the retired name from
// 7.0.5 on, when neither did (measured 2026-10-26: zero whole-token matches).
export const has = (text, needle) =>
  new RegExp(`(?<![A-Za-z0-9_])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`).test(text);
export const missing = (text, names) => names.filter((n) => !has(text, n));
export const present = (text, names) => names.filter((n) => has(text, n));

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const isVersion = (value) => typeof value === "string" && SEMVER.test(value);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The names a version must be bound to before it counts as this server's. */
export const GLAMA_REPOSITORY = "HemmaBo-se/hemmabo-mcp-server";
export const MCPSO_SERVER_NAME = "hemmabo-mcp-server";
export const MCPSO_ENDPOINT = "https://www.hemmabo.com/mcp";

/**
 * The bodies of the page's <script> elements, in order. HTML comments outside
 * a script are skipped whole, so a fragment that only sits in a comment is
 * never read. A scan, not a regex; the bodies are parsed as data below, never
 * executed.
 */
export function scriptBodies(html) {
  const lower = html.toLowerCase();
  const bodies = [];
  let i = 0;
  for (;;) {
    const comment = lower.indexOf("<!--", i);
    const script = lower.indexOf("<script", i);
    if (script === -1) return bodies;
    if (comment !== -1 && comment < script) {
      const end = lower.indexOf("-->", comment + 4);
      if (end === -1) return bodies;
      i = end + 3;
      continue;
    }
    const open = lower.indexOf(">", script);
    if (open === -1) return bodies;
    const close = lower.indexOf("</script", open);
    bodies.push(html.slice(open + 1, close === -1 ? html.length : close));
    if (close === -1) return bodies;
    i = close + 8;
  }
}

/** Every double-quoted string literal that follows `prefix` in the text, decoded; undecodable ones are dropped. */
function literalsAfter(text, prefix) {
  const out = [];
  const pattern = new RegExp(`${prefix}("(?:[^"\\\\]|\\\\.)*")`, "g");
  for (const m of text.matchAll(pattern)) {
    try {
      const value = JSON.parse(m[1]);
      if (typeof value === "string") out.push(value);
    } catch {
      // not a JSON-compatible literal: not read
    }
  }
  return out;
}

/**
 * The version the Glama server page states for this server: `version` of the
 * `latestRelease` of the repository record whose `githubRepository.fullName`
 * is HemmaBo-se/hemmabo-mcp-server.
 *
 * Glama serializes its page data as one flat JSON array (turbo-stream):
 * an object is `{"_<index of the key string>": <index of the value>}`. The
 * array is decoded and walked; nothing is matched as text. A `version` that
 * belongs to another key (`archivedRelease`), to another repository, or that
 * sits outside the page data, is not read.
 */
export function glamaServerVersions(html) {
  const found = [];
  for (const body of scriptBodies(html)) {
    for (const chunk of literalsAfter(body, "streamController\\.enqueue\\(")) {
      let table;
      try {
        table = JSON.parse(chunk);
      } catch {
        continue;
      }
      if (!Array.isArray(table)) continue;
      const at = (ref) => (Number.isInteger(ref) && ref >= 0 ? table[ref] : undefined);
      // The value of the member named `name`, exactly, in a serialized object.
      const member = (object, name) => {
        if (!isRecord(object)) return undefined;
        for (const [key, ref] of Object.entries(object)) {
          if (/^_\d+$/.test(key) && table[Number(key.slice(1))] === name) return at(ref);
        }
        return undefined;
      };
      for (const entry of table) {
        const release = member(entry, "latestRelease");
        if (!isRecord(release)) continue;
        if (member(member(entry, "githubRepository"), "fullName") !== GLAMA_REPOSITORY) continue;
        const version = member(release, "version");
        if (isVersion(version)) found.push(version);
      }
    }
  }
  return [...new Set(found)];
}

/**
 * The version mcp.so states for this server: `probe.serverVersion` in the
 * listing's `qualityDetails`, the record of mcp.so's own connection test,
 * when that probe names this server (`serverName`) and its endpoint (`url`).
 * The record is a JSON string inside the page's script data; it is decoded
 * and read by exact member name, so `previous_serverVersion`, another
 * server's probe, or a fragment in a comment is not read.
 */
export function mcpsoProbes(html) {
  const probes = [];
  for (const body of scriptBodies(html)) {
    for (const text of literalsAfter(body, "qualityDetails:")) {
      let details;
      try {
        details = JSON.parse(text);
      } catch {
        continue;
      }
      const probe = isRecord(details) ? details.probe : undefined;
      if (!isRecord(probe)) continue;
      if (probe.serverName !== MCPSO_SERVER_NAME || probe.url !== MCPSO_ENDPOINT) continue;
      if (!Object.hasOwn(probe, "serverVersion") || !isVersion(probe.serverVersion)) continue;
      probes.push({ version: probe.serverVersion, checkedAt: typeof probe.checkedAt === "string" ? probe.checkedAt : null });
    }
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
