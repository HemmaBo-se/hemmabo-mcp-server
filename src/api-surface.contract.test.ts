import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_ROOT = resolve(REPO_ROOT, "api");

const INTENTIONAL_API_FUNCTIONS = [
  "api/acp.ts",
  "api/health.ts",
  "api/mcp-manifest.ts",
  "api/mcp.ts",
  "api/oauth-authorization-server.ts",
  "api/oauth-authorize.ts",
  "api/oauth-protected-resource.ts",
  "api/oauth-register.ts",
  "api/oauth.ts",
  "api/openai-apps-challenge.ts",
  "api/server-card.ts",
  "api/stripe-webhook.ts",
].sort();

function findApiTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      findApiTsFiles(absolute, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(relative(REPO_ROOT, absolute).replaceAll("\\", "/"));
    }
  }
  return out;
}

function isVercelIgnoredApiFile(path: string): boolean {
  const name = basename(path);
  return name.startsWith("_") || name.startsWith(".") || name.endsWith(".d.ts");
}

describe("api/ Vercel function surface", () => {
  it("only exposes intentional API function entrypoints", () => {
    const deployableApiFiles = findApiTsFiles(API_ROOT)
      .filter((path) => !isVercelIgnoredApiFile(path))
      .sort();

    assert.deepEqual(
      deployableApiFiles,
      INTENTIONAL_API_FUNCTIONS,
      [
        "api/ contains a deployable TypeScript file that is not in the intentional endpoint allowlist.",
        "Every new Vercel Function must be deliberate and reviewed; helper files in api/ must use an ignored filename such as _types.ts.",
      ].join(" ")
    );
  });
});
