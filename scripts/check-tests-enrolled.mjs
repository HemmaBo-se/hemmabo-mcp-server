#!/usr/bin/env node
/**
 * Test-file enrollment guard (#62).
 *
 * The auditor of test discipline. Confirms that:
 *   1. Every `*.test.ts` file in the repo lives under `src/` (where the
 *      glob runner can find it). Test files dropped into `api/`, `lib/`,
 *      or random folders are NOT executed by `npm test` and represent
 *      silent coverage loss.
 *   2. `package.json:scripts.test` invokes the glob runner, not a
 *      hardcoded file list. A hardcoded list is the failure mode that
 *      issue #62 exists to prevent.
 *
 * Exits non-zero on drift so CI fails loudly before merge.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(__filename));

function findFiles(dir, suffix, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) findFiles(abs, suffix, out);
    else if (entry.isFile() && entry.name.endsWith(suffix)) out.push(abs);
  }
  return out;
}

let failures = 0;

// ── Check 1: all *.test.ts files live under src/ ────────────────
const allTests = findFiles(ROOT, ".test.ts").map((f) => relative(ROOT, f));
const orphans = allTests.filter((f) => !f.startsWith("src/"));
if (orphans.length > 0) {
  console.error("✗ Test files outside src/ — these will NOT be executed:");
  for (const f of orphans) console.error(`    ${f}`);
  console.error("  Move them under src/ or rename if not actually tests.");
  failures++;
} else {
  console.log(`✓ All ${allTests.length} test file(s) live under src/`);
}

// ── Check 2: package.json test script uses the runner ───────────
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const testScript = pkg.scripts?.test ?? "";
if (!/scripts\/run-tests\.mjs/.test(testScript)) {
  console.error(
    "✗ package.json:scripts.test does not invoke scripts/run-tests.mjs."
  );
  console.error(`    Current value: ${JSON.stringify(testScript)}`);
  console.error(
    "  Expected: node scripts/run-tests.mjs  (so new tests auto-enroll)."
  );
  failures++;
} else {
  console.log("✓ package.json:scripts.test uses the glob runner");
}

// ── Check 3: hardcoded file paths in test script are forbidden ──
// Some teams hot-patch `npm test` with `&& tsx --test src/oneoff.test.ts`
// to fix a single broken file. Catch that.
if (/src\/.*\.test\.ts/.test(testScript)) {
  console.error(
    "✗ package.json:scripts.test contains a hardcoded src/*.test.ts path."
  );
  console.error(`    Current value: ${JSON.stringify(testScript)}`);
  console.error(
    "  Remove the hardcoded path; the runner enumerates files itself."
  );
  failures++;
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll enrollment checks passed.");
