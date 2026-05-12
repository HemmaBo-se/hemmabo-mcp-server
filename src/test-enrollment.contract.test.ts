/**
 * Contract: glob-driven test runner is wired and tamper-proof (#62).
 *
 * The runner enumerates src/**\/*.test.ts at execution time, so the
 * runtime behaviour is "if a test file exists, it runs". The risk
 * #62 closes is a regression where someone replaces the glob with a
 * hardcoded list (the old failure mode) and silently de-enrols files.
 *
 * These checks all operate on file contents — they don't require Upstash,
 * Supabase, or any network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

async function readSource(rel: string): Promise<string> {
  return readFile(resolve(ROOT, rel), "utf8");
}

test("package.json:scripts.test points at the glob runner", async () => {
  const pkg = JSON.parse(await readSource("package.json")) as {
    scripts?: Record<string, string>;
  };
  const t = pkg.scripts?.test ?? "";
  assert.match(
    t,
    /scripts\/run-tests\.mjs/,
    "test script must invoke scripts/run-tests.mjs"
  );
  // The old failure mode: comma/space-separated hardcoded src/*.test.ts paths.
  assert.doesNotMatch(
    t,
    /src\/[A-Za-z0-9._-]+\.test\.ts/,
    "test script must NOT hardcode any src/*.test.ts paths"
  );
});

test("package.json exposes test:enrolled drift guard", async () => {
  const pkg = JSON.parse(await readSource("package.json")) as {
    scripts?: Record<string, string>;
  };
  assert.match(
    pkg.scripts?.["test:enrolled"] ?? "",
    /scripts\/check-tests-enrolled\.mjs/,
    "test:enrolled must invoke the enrollment guard"
  );
});

test("CI workflow runs test:enrolled before test", async () => {
  const ci = await readSource(".github/workflows/ci.yml");
  const enrolledIdx = ci.indexOf("test:enrolled");
  const testIdx = ci.search(/run:\s*npm test\b/);
  assert.ok(enrolledIdx > -1, "CI must run npm run test:enrolled");
  assert.ok(testIdx > -1, "CI must run npm test");
  assert.ok(
    enrolledIdx < testIdx,
    "test:enrolled must run before npm test so drift fails fast"
  );
});

test("runner script exists and enumerates src/**\\/*.test.ts", async () => {
  const src = await readSource("scripts/run-tests.mjs");
  // Glob behaviour comes from a recursive readdirSync — that's the contract.
  assert.match(src, /\.test\.ts/, "runner must filter on .test.ts suffix");
  assert.match(src, /\bspawn\b/, "runner must spawn a child process");
  assert.match(src, /tsx/, "runner must invoke tsx");
  // Empty-set exit code is the failure mode the runner was designed to surface.
  assert.match(
    src,
    /process\.exit\(\s*2\s*\)/,
    "runner must exit with code 2 when no test files are found"
  );
});

test("enrollment guard script exists with both rules", async () => {
  const src = await readSource("scripts/check-tests-enrolled.mjs");
  assert.match(src, /\.test\.ts/);
  assert.match(
    src,
    /src\//,
    "guard must require tests to live under src/"
  );
  assert.match(
    src,
    /scripts\/run-tests\.mjs/,
    "guard must require test script to invoke the runner"
  );
});

test("every *.test.ts file in the repo lives under src/", async () => {
  // Cross-check the guard at the contract layer. If this fails, either a
  // test file got orphaned or the runner can't see it — either way `npm test`
  // would silently skip it on main.
  async function walk(dir: string, out: string[] = []): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.name === "node_modules" || e.name === "dist") continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs, out);
      else if (e.isFile() && e.name.endsWith(".test.ts")) out.push(abs);
    }
    return out;
  }
  const found = (await walk(ROOT)).map((f) => relative(ROOT, f));
  const orphans = found.filter((f) => !f.startsWith("src/"));
  assert.deepEqual(
    orphans,
    [],
    `Found *.test.ts file(s) outside src/ — they will not run: ${orphans.join(", ")}`
  );
});

test("runner script is executable as a node module", async () => {
  // Smoke: file exists and is readable. We don't actually spawn it here
  // because the parent test run is already inside the runner.
  const s = await stat(resolve(ROOT, "scripts/run-tests.mjs"));
  assert.ok(s.isFile(), "runner must be a regular file");
  assert.ok(s.size > 0, "runner must not be empty");
});
