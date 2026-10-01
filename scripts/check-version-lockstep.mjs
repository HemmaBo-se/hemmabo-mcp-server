#!/usr/bin/env node
/**
 * check-version-lockstep.mjs — fail CI if the published version number drifts
 * between the surfaces that are meant to stay in lock-step.
 *
 * .plugin/plugin.json drifted to 3.2.8 while package.json/server.json/glama.json
 * moved on to 3.2.16 with nothing catching it (found 2026-07-22, fixed same day).
 * This guard exists so that class of drift fails CI instead of sitting unnoticed.
 *
 * Invariant: package.json .version == server.json .version == glama.json .version
 *            == .plugin/plugin.json .version (byte-identical strings).
 *
 * Run: node scripts/check-version-lockstep.mjs   (no build required)
 */

import { readFileSync } from "node:fs";

function versionOf(path) {
  const v = JSON.parse(readFileSync(path, "utf8")).version;
  if (typeof v !== "string") throw new Error(`${path}: missing string .version`);
  return v;
}

const surfaces = {
  "package.json": versionOf("package.json"),
  "server.json": versionOf("server.json"),
  "glama.json": versionOf("glama.json"),
  ".plugin/plugin.json": versionOf(".plugin/plugin.json"),
};

const canonicalKey = "package.json";
const canonical = surfaces[canonicalKey];

let failed = false;
for (const [name, value] of Object.entries(surfaces)) {
  if (name === canonicalKey) continue;
  if (value !== canonical) {
    failed = true;
    console.error(
      `::error::version-lockstep — ${name} version "${value}" != ${canonicalKey} version "${canonical}".`,
    );
  }
}

if (failed) {
  console.error("version-lockstep check: FAILED — bump every surface above to the same version.");
  process.exit(1);
}

console.log(
  `version-lockstep: OK — ${Object.keys(surfaces).length} surfaces all at version ${canonical}.`,
);
