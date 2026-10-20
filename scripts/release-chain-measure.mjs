#!/usr/bin/env node
/**
 * release-chain-measure.mjs — measure every catalog surface at one version.
 *
 * A version change is done when it is released, and a release is done when
 * every surface that agents and directories read carries it (AGENTS.md,
 * «A version change is done when it is released»). npm and the MCP Registry
 * follow the GitHub release by workflow; Glama, Smithery, mcp.so, Docker Hub,
 * the GitHub MCP Registry and the OpenAI app each have their own path, and
 * the chain has stopped at one of them more than once. This script reads
 * every surface live and says which rows are at the version, which are not,
 * and what to do about each one. .github/workflows/release-chain.yml runs it
 * on every release and keeps the result in one issue per version.
 *
 * Run: node scripts/release-chain-measure.mjs [--version X.Y.Z] [--wait MIN] [--out DIR]
 *   --version  the version to measure; default: package.json
 *   --wait     poll the automatic rows (production, npm, MCP Registry) for up
 *              to MIN minutes before the final reading; default 0
 *   --out      write report.md, report.json and title.txt into DIR
 * Exit 1 when an automatic row is not at the version after the wait. Catalog
 * rows never fail the run: they are measured and reported, and their fix is a
 * hand step with a direct link.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 || !args[i + 1] ? fallback : args[i + 1];
};

const VERSION = opt("--version", JSON.parse(readFileSync("package.json", "utf8")).version);
const WAIT_MINUTES = Number(opt("--wait", "0"));
const OUT_DIR = opt("--out", "");

const PLATFORM = "https://www.hemmabo.com";
const USER_AGENT = "Mozilla/5.0 (compatible; hemmabo-release-chain/1; +https://www.hemmabo.com)";

const LINKS = {
  glamaDockerfile: "https://glama.ai/mcp/servers/HemmaBo-se/hemmabo-mcp-server/admin/dockerfile",
  glamaRepository: "https://glama.ai/mcp/servers/HemmaBo-se/hemmabo-mcp-server/admin/repository",
  glamaServer: "https://glama.ai/mcp/servers/HemmaBo-se/hemmabo-mcp-server",
  glamaConnector: "https://glama.ai/mcp/connectors/com.hemmabo/hemmabo-mcp-server",
  smithery: "https://smithery.ai/servers/info-00wt/hemmabo-mcp-server",
  smitheryApi: "https://registry.smithery.ai/servers/info-00wt/hemmabo-mcp-server",
  mcpso: "https://mcp.so/servers/hemmabo-mcp-server",
  mcpsoTickets: "https://mcp.so/settings/tickets",
  dockerHub: "https://hub.docker.com/v2/repositories/mcp/hemmabo/",
  dockerPr: "https://github.com/docker/mcp-registry/pull/4413",
  githubMcp: "https://github.com/mcp",
  openaiSubmission: "https://developers.openai.com/plugins/deploy/submission",
  npm: "https://www.npmjs.com/package/hemmabo-mcp-server",
  registry: "https://registry.modelcontextprotocol.io/v0.1/servers?search=hemmabo&version=latest",
  release: `https://github.com/HemmaBo-se/hemmabo-mcp-server/releases/tag/v${VERSION}`,
};

async function http(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(40_000),
    redirect: "follow",
  });
  return { status: res.status, text: await res.text() };
}

/** One JSON-RPC call over streamable HTTP; the answer may be JSON or one SSE event. */
async function rpc(url, method, params = {}) {
  const { status, text } = await http(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const event = text.match(/^data: (.*)$/m);
  return JSON.parse(event ? event[1] : text);
}

const INIT_PARAMS = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "hemmabo-release-chain", version: "1" },
};

/** The names the server retired at the 6.0.0 rename: the alias keys without a dot. */
function retiredToolNames() {
  const src = readFileSync("lib/tools-base.ts", "utf8");
  const start = src.indexOf("const TOOL_NAME_ALIASES");
  const block = src.slice(start, src.indexOf("};", start));
  return [...block.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
}

/**
 * The page without its script bodies: a catalog page's script data names
 * every tool it has ever known, and only the readable text counts. A scan,
 * not a regex, so any case and any spacing of the tags is handled. The
 * result is measured, never rendered or executed.
 */
function withoutScripts(html) {
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
const visible = (html) => withoutScripts(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const has = (text, needle) => text.includes(needle);
const missing = (text, names) => names.filter((n) => !has(text, n));
const present = (text, names) => names.filter((n) => has(text, n));

/**
 * Every surface. kind: "auto" rows follow the release by machine and fail the
 * run when they are not at the version; "catalog" rows are measured and
 * reported, their fix is a hand step; "manual" rows cannot be measured and are
 * a checkbox in the issue.
 */
const ROWS = [
  {
    id: "production",
    label: `Production \`${PLATFORM}/mcp\` and \`/mcp/chatgpt\``,
    kind: "auto",
    who: "Vercel deploys main",
    async check(ctx) {
      const a = await rpc(`${PLATFORM}/mcp`, "initialize", INIT_PARAMS);
      const b = await rpc(`${PLATFORM}/mcp/chatgpt`, "initialize", INIT_PARAMS);
      const va = a.result?.serverInfo?.version;
      const vb = b.result?.serverInfo?.version;
      const tools = await rpc(`${PLATFORM}/mcp`, "tools/list", {});
      ctx.toolNames = (tools.result?.tools ?? []).map((t) => t.name).sort();
      return { ok: va === VERSION && vb === VERSION, detail: `/mcp ${va}, /mcp/chatgpt ${vb}, ${ctx.toolNames.length} tools` };
    },
  },
  {
    id: "manifest",
    label: `\`${PLATFORM}/.well-known/mcp.json\``,
    kind: "auto",
    who: "Vercel deploys main",
    async check() {
      const { text } = await http(`${PLATFORM}/.well-known/mcp.json`);
      const v = JSON.parse(text).version;
      return { ok: v === VERSION, detail: `version ${v}` };
    },
  },
  {
    id: "npm",
    label: `[npm](${LINKS.npm})`,
    kind: "auto",
    who: "`npm-publish.yml` on the GitHub release",
    async check() {
      const { text } = await http("https://registry.npmjs.org/hemmabo-mcp-server");
      const doc = JSON.parse(text);
      const latest = doc["dist-tags"]?.latest;
      return { ok: latest === VERSION, detail: `latest ${latest}, ${VERSION} published ${doc.time?.[VERSION] ?? "no"}` };
    },
  },
  {
    id: "registry",
    label: "[MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=hemmabo)",
    kind: "auto",
    who: "`mcp-registry-publish.yml` on the GitHub release",
    async check() {
      const { text } = await http(LINKS.registry);
      const entry = (JSON.parse(text).servers ?? []).map((s) => ({ server: s.server ?? s, meta: s._meta?.["io.modelcontextprotocol.registry/official"] ?? {} }))
        .find((e) => e.server.name === "com.hemmabo/hemmabo-mcp-server");
      const v = entry?.server.version;
      return { ok: v === VERSION && entry?.meta.status === "active", detail: `${v ?? "absent"} ${entry?.meta.status ?? ""} ${entry?.meta.publishedAt ?? ""}`.trim() };
    },
  },
  {
    id: "glama-connector",
    label: `[Glama connector](${LINKS.glamaConnector})`,
    kind: "catalog",
    who: "Glama reads the MCP Registry; nothing to do by hand",
    hand: false,
    async check(ctx) {
      const { status, text } = await http(LINKS.glamaConnector);
      const page = visible(text);
      // The connector's changelog records the 6.0.0 rename, so retired names
      // are expected there; the tool list is what must be current.
      const gone = missing(page, ctx.toolNames);
      return { ok: status === 200 && gone.length === 0, detail: status !== 200 ? `HTTP ${status}` : `${gone.length ? `missing ${gone.join(", ")}` : "all tools"} (the page shows no version)` };
    },
  },
  {
    id: "glama-server",
    label: `[Glama server page](${LINKS.glamaServer})`,
    kind: "catalog",
    who: `Glama builds the repo. Green build + GitHub release = Auto-Release. Red or stale: [Repository → Sync Server](${LINKS.glamaRepository}), then [Dockerfile → Build & Release](${LINKS.glamaDockerfile}) with an empty pinned SHA`,
    async check(ctx) {
      const { status, text } = await http(LINKS.glamaServer);
      const page = visible(text);
      const from = page.indexOf("Available Tools");
      const list = from === -1 ? "" : page.slice(from, page.indexOf("Tool Schema Changelog", from) === -1 ? from + 6000 : page.indexOf("Tool Schema Changelog", from));
      const gone = missing(list, ctx.toolNames);
      const old = present(list, ctx.retiredNames);
      return { ok: status === 200 && from !== -1 && gone.length === 0 && old.length === 0, detail: status !== 200 ? `HTTP ${status}` : from === -1 ? "no tool list" : `${gone.length ? `missing ${gone.join(", ")}` : "all tools"}${old.length ? `; retired names listed: ${old.join(", ")}` : ""}` };
    },
  },
  {
    id: "smithery",
    label: `[Smithery](${LINKS.smithery})`,
    kind: "catalog",
    who: `\`smithery.yaml\` + Smithery's scan; stale: [the listing](${LINKS.smithery}) → Publish. Smithery closes its run.tools proxy, API and CLI on 2026-10-31; the listing must show ${PLATFORM}/mcp: [Settings → Verification](${LINKS.smithery}/settings/verification)`,
    async check(ctx) {
      // The registry API while it answers; after 2026-10-31 the listing page's own data.
      const api = await http(LINKS.smitheryApi);
      let names = null;
      let proxied = false;
      try {
        const record = JSON.parse(api.text);
        names = (record.tools ?? []).map((t) => t.name).sort();
        proxied = JSON.stringify([record.deploymentUrl, record.connections]).includes(".run.tools");
      } catch {
        names = null;
      }
      let source = "registry API";
      let status = api.status;
      if (status !== 200 || !names) {
        const page = await http(LINKS.smithery);
        status = page.status;
        names = ctx.toolNames.filter((n) => has(page.text, n));
        proxied = has(page.text, ".run.tools");
        source = "listing page";
      }
      const same = names.length === ctx.toolNames.length && names.every((n, i) => n === ctx.toolNames[i]);
      const tools = same ? `${names.length} tools, same names as production` : `tools ${names.join(", ") || "none"}`;
      const url = proxied ? "connects through the run.tools proxy, which closes 2026-10-31" : `no run.tools proxy`;
      return { ok: status === 200 && same && !proxied, detail: `${source}: ${tools}; ${url}` };
    },
  },
  {
    id: "mcpso",
    label: `[mcp.so](${LINKS.mcpso})`,
    kind: "catalog",
    who: `only mcp.so can rescan: [support ticket](${LINKS.mcpsoTickets}) and support@mcp.so`,
    async check(ctx) {
      const { status, text } = await http(LINKS.mcpso);
      const page = visible(text);
      const gone = missing(page, ctx.toolNames);
      const old = present(page, ctx.retiredNames);
      return { ok: status === 200 && gone.length === 0 && old.length === 0, detail: status !== 200 ? `HTTP ${status}` : `${gone.length ? `missing ${gone.join(", ")}` : "all tools"}${old.length ? `; retired names listed: ${old.join(", ")}` : ""}` };
    },
  },
  {
    id: "docker",
    label: "[Docker Hub MCP catalog](https://hub.docker.com/mcp)",
    kind: "catalog",
    who: `listing waits on [docker/mcp-registry#4413](${LINKS.dockerPr})`,
    async check() {
      const { status } = await http(LINKS.dockerHub);
      return { ok: status === 200, detail: status === 200 ? "mcp/hemmabo listed" : `mcp/hemmabo HTTP ${status}, not listed` };
    },
  },
  {
    id: "github-mcp",
    label: `[GitHub MCP Registry](${LINKS.githubMcp})`,
    kind: "manual",
    who: "GitHub curates it by hand (partnerships@github.com); once listed, versions sync from the MCP Registry",
  },
  {
    id: "openai",
    label: `[OpenAI app](${LINKS.openaiSubmission})`,
    kind: "manual",
    who: "CEO: Rescan on the app's MCPs tab, only when a tool or tool text on `/mcp/chatgpt` changed",
  },
];

async function measure(rows, ctx) {
  const out = [];
  for (const row of rows) {
    if (row.kind === "manual") {
      out.push({ ...row, ok: null, detail: "" });
      continue;
    }
    try {
      out.push({ ...row, ...(await row.check(ctx)) });
    } catch (err) {
      out.push({ ...row, ok: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return out;
}

const ctx = { toolNames: [], retiredNames: retiredToolNames() };
const autoRows = ROWS.filter((r) => r.kind === "auto");
const started = Date.now();
let autoResult = await measure(autoRows, ctx);
while (autoResult.some((r) => !r.ok) && Date.now() - started < WAIT_MINUTES * 60_000) {
  console.log(`waiting: ${autoResult.filter((r) => !r.ok).map((r) => `${r.id} (${r.detail})`).join("; ")}`);
  await sleep(60_000);
  autoResult = await measure(autoRows, ctx);
}
const rest = await measure(ROWS.filter((r) => r.kind !== "auto"), ctx);
const results = [...autoResult, ...rest];

const measuredAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const mark = (r) => (r.ok === null ? "🖐" : r.ok ? "✅" : "❌");
const run = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
  ? ` · [run](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID})`
  : "";
const title = `Release v${VERSION}: the chain`;
const lines = [
  `## ${title}`,
  "",
  `Every surface that agents and directories read, measured at ${measuredAt}${run}. [Release](${LINKS.release}). A release is done when every row is ✅ and every hand step is ticked.`,
  "",
  "| Surface | At " + VERSION + " | Measured | Who changes it, and where |",
  "|---|---|---|---|",
  ...results.filter((r) => r.kind !== "manual").map((r) => `| ${r.label} | ${mark(r)} | ${r.detail} | ${r.who} |`),
  "",
  "### Hand steps (tick here)",
  ...results.filter((r) => r.kind === "manual").map((r) => `- [ ] ${r.label}: ${r.who}`),
  ...results.filter((r) => r.kind === "catalog" && r.ok === false && r.hand !== false).map((r) => `- [ ] ${r.label}: ${r.who}`),
  "",
  "Re-measure after a hand step: Actions → **Release chain** → Run workflow (version " + VERSION + "), or locally `node scripts/release-chain-measure.mjs --version " + VERSION + "`.",
];
const report = lines.join("\n") + "\n";

console.log(report);
if (OUT_DIR) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "report.md"), report);
  writeFileSync(join(OUT_DIR, "title.txt"), title + "\n");
  writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify({ version: VERSION, measuredAt, rows: results.map(({ id, kind, ok, detail }) => ({ id, kind, ok, detail })) }, null, 2) + "\n");
}

const stuck = results.filter((r) => r.kind === "auto" && !r.ok);
if (stuck.length) {
  console.error(`Not at ${VERSION}: ${stuck.map((r) => `${r.id} (${r.detail})`).join("; ")}`);
  process.exit(1);
}
