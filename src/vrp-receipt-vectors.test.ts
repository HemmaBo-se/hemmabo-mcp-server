import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReceipt, type JwksResolver } from "../lib/vrp-receipt.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VECTORS_DIR = join(REPO_ROOT, "spec", "vectors");

interface Vector {
  name: string;
  description: string;
  now: string;
  jwks: Record<string, unknown>;
  receipt: unknown;
  expected: unknown;
}

const vectorFiles = readdirSync(VECTORS_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

test("public receipt vectors exist (ADR 0010 Phase 4)", () => {
  assert.ok(vectorFiles.length >= 6, `expected the published vector set, found ${vectorFiles.length}`);
});

for (const file of vectorFiles) {
  const v = JSON.parse(readFileSync(join(VECTORS_DIR, file), "utf8")) as Vector;
  test(`vector ${file}: verifyReceipt matches the published expected result`, () => {
    const resolveJwks: JwksResolver = () => v.jwks;
    const result = verifyReceipt(v.receipt, { resolveJwks, now: Date.parse(v.now) });
    assert.deepEqual(
      result,
      v.expected,
      `${file} (${v.description}) — verifier output diverged from the committed expected result`,
    );
  });
}
