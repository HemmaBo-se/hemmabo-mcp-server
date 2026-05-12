#!/usr/bin/env node
/**
 * Glob-driven test runner (#62).
 *
 * Replaces the hardcoded file list in `package.json:scripts.test`. Every
 * file matching `src/**\/*.test.ts` is auto-enrolled. Adding a new test
 * file is a single git add — no second edit to package.json.
 *
 * Why a script instead of `tsx --test 'src/**\/*.test.ts'`:
 *   - Cross-shell glob behaviour is unreliable (bash needs `shopt -s
 *     globstar`, Windows cmd doesn't expand at all). A Node-based glob
 *     gives us deterministic enumeration on every platform.
 *   - The runner can fail loudly when zero files match — a hardcoded
 *     "passed" exit on an empty test set is the kind of silent regression
 *     that motivated #62 in the first place.
 *
 * Exit codes:
 *   0   all tests passed
 *   1   one or more tests failed (passed through from tsx)
 *   2   no test files found under src/ (configuration error)
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(__filename));

/** Recursively collect *.test.ts files under `dir`. */
function findTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findTestFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(abs);
    }
  }
  return out;
}

const srcDir = join(ROOT, "src");
const files = findTestFiles(srcDir).sort();

if (files.length === 0) {
  console.error("✗ No test files found under src/. Did you delete them all?");
  process.exit(2);
}

const rel = files.map((f) => relative(ROOT, f));
console.log(`▶ Running ${rel.length} test file(s):`);
for (const f of rel) console.log(`  • ${f}`);
console.log("");

const child = spawn("npx", ["tsx", "--test", ...rel], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`✗ Test runner killed by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
