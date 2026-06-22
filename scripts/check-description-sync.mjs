#!/usr/bin/env node
/**
 * check-description-sync.mjs — fail CI if the server description drifts between
 * the surfaces that are meant to stay in lock-step.
 *
 * The SAME description is hand-duplicated across registry/runtime surfaces, and
 * that duplication is the root cause of every cross-surface drift we have hit
 * (11-vs-12 languages, 13-vs-15 tools, "Stripe Agentic Commerce Protocol").
 * The facts-drift gate pins specific FACTS; this gate pins the whole STRING.
 *
 * Invariant (intentional structure, verified):
 *   - The three registry surfaces carry the SAME full description:
 *       glama.json .description == package.json .description == smithery.yaml description
 *   - The runtime MCP description is that same description WITHOUT the leading
 *     npm/registry hook sentence, i.e. the registry description ENDS WITH
 *     lib/server-metadata.ts SERVER_DESCRIPTION. So the shared body cannot drift
 *     between what registries show and what agents read at runtime.
 *
 * Edit the description = update all three registry copies identically, and keep
 * SERVER_DESCRIPTION equal to their shared tail.
 *
 * Run: node scripts/check-description-sync.mjs   (no build required)
 */

import { readFileSync } from "node:fs";

function fromJson(path) {
  const d = JSON.parse(readFileSync(path, "utf8")).description;
  if (typeof d !== "string") throw new Error(`${path}: missing string .description`);
  return d;
}
function fromRegex(path, re, label) {
  const m = readFileSync(path, "utf8").match(re);
  if (!m) throw new Error(`Could not extract description from ${label} (${path}) — pattern changed?`);
  return m[1];
}

// The three registry descriptions that MUST be byte-identical.
const registry = {
  "glama.json": fromJson("glama.json"),
  "package.json": fromJson("package.json"),
  "smithery.yaml": fromRegex("smithery.yaml", /^description:\s*"([^"]*)"/m, "smithery.yaml"),
};
// The runtime MCP description — the shared tail of the registry description.
const serverDescription = fromRegex(
  "lib/server-metadata.ts",
  /SERVER_DESCRIPTION\s*=\s*"([^"]*)"/,
  "lib/server-metadata.ts",
);

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

let failed = false;
const canonicalKey = "glama.json";
const canonical = registry[canonicalKey];

// 1. The three registry surfaces must be byte-identical.
for (const [name, value] of Object.entries(registry)) {
  if (name === canonicalKey) continue;
  if (value !== canonical) {
    failed = true;
    const i = firstDiff(canonical, value);
    console.error(`::error::description-sync — ${name} description differs from ${canonicalKey} (must be byte-identical).`);
    console.error(`  ${canonicalKey} (${canonical.length} chars) vs ${name} (${value.length} chars); first diff at index ${i}`);
    console.error(`    ${canonicalKey}[${i}..]: ${JSON.stringify(canonical.slice(i, i + 70))}`);
    console.error(`    ${name}[${i}..]: ${JSON.stringify(value.slice(i, i + 70))}\n`);
  }
}

// 2. The runtime SERVER_DESCRIPTION must be the shared tail of the registry one.
if (!canonical.endsWith(serverDescription)) {
  failed = true;
  // Diagnose: where does the registry tail diverge from SERVER_DESCRIPTION?
  const tail = canonical.slice(Math.max(0, canonical.length - serverDescription.length));
  const i = firstDiff(tail, serverDescription);
  console.error(`::error::description-sync — lib/server-metadata.ts SERVER_DESCRIPTION is not the tail of the registry description.`);
  console.error(`  registry (${canonical.length} chars) must END WITH SERVER_DESCRIPTION (${serverDescription.length} chars); diverges near index ${i} of the tail`);
  console.error(`    registry tail[${i}..]: ${JSON.stringify(tail.slice(i, i + 70))}`);
  console.error(`    SERVER_DESCRIPTION[${i}..]: ${JSON.stringify(serverDescription.slice(i, i + 70))}`);
  console.error(`  fix: keep SERVER_DESCRIPTION equal to the registry description minus its leading hook sentence.\n`);
}

if (failed) {
  console.error("description-sync check: FAILED — make the descriptions agree (see above).");
  process.exit(1);
}

console.log(
  `description-sync: OK — registry description byte-identical across ` +
  `${Object.keys(registry).length} surfaces (${canonical.length} chars); ` +
  `SERVER_DESCRIPTION (${serverDescription.length} chars) is its shared tail.`,
);
