import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const TEST_KEY = "oauth-contract-test-key";
let originalKey: string | undefined;

before(() => {
  originalKey = process.env.MCP_API_KEY;
  process.env.MCP_API_KEY = TEST_KEY;
});

after(() => {
  if (originalKey === undefined) delete process.env.MCP_API_KEY;
  else process.env.MCP_API_KEY = originalKey;
});

describe("validateAuth runtime contract (#64)", () => {
  it("accepts the MCP_API_KEY as a Bearer token", async () => {
    const { validateAuth } = await import("./auth.js");
    const result = await validateAuth(`Bearer ${TEST_KEY}`);
    assert.equal(result, null);
  });

  it("rejects a missing Authorization header", async () => {
    const { validateAuth } = await import("./auth.js");
    const result = await validateAuth(undefined);
    assert.match(result ?? "", /Authorization required/);
  });

  it("rejects an empty Bearer token", async () => {
    const { validateAuth } = await import("./auth.js");
    const result = await validateAuth("Bearer ");
    assert.match(result ?? "", /Empty Bearer token/);
  });

  it("rejects a wrong key without crashing when Supabase env is absent", async () => {
    const { validateAuth } = await import("./auth.js");
    const result = await validateAuth("Bearer not-the-key");
    assert.equal(result, "Invalid API key");
  });

  it("opens auth when MCP_API_KEY is unset", async () => {
    const saved = process.env.MCP_API_KEY;
    delete process.env.MCP_API_KEY;
    try {
      const { validateAuth } = await import("./auth.js");
      const result = await validateAuth(undefined);
      assert.equal(result, null);
    } finally {
      process.env.MCP_API_KEY = saved;
    }
  });
});

describe("validateAuth wired into entrypoints (#64)", () => {
  const entrypoints = [
    // api/mcp.ts is now a thin VRP-aware wrapper; the original transport and
    // protected-tool auth gate live in api/mcp-base.ts.
    { name: "api/mcp-base.ts", path: join(repoRoot, "api/mcp-base.ts") },
    { name: "api/acp.ts", path: join(repoRoot, "api/acp.ts") },
    { name: "src/index.ts", path: join(repoRoot, "src/index.ts") },
  ];

  for (const { name, path } of entrypoints) {
    it(`${name} imports validateAuth (not validateApiKey)`, () => {
      const source = readFileSync(path, "utf8");
      const importsValidateAuth = /import\s*{[^}]*\bvalidateAuth\b[^}]*}\s*from\s*["']\.{1,2}\/[^"']*auth(?:\.js)?["']/.test(source);
      const importsValidateApiKey = /import\s*{[^}]*\bvalidateApiKey\b[^}]*}\s*from\s*["']\.{1,2}\/[^"']*auth(?:\.js)?["']/.test(source);
      assert.equal(importsValidateAuth, true, `${name} must import { validateAuth } from src/auth`);
      assert.equal(importsValidateApiKey, false, `${name} must NOT import the deprecated validateApiKey`);
    });

    it(`${name} calls validateAuth, not validateApiKey`, () => {
      const source = readFileSync(path, "utf8");
      assert.ok(/\bvalidateAuth\s*\(/.test(source), `${name} must call validateAuth(...)`);
      assert.ok(!/\bvalidateApiKey\s*\(/.test(source), `${name} must NOT call validateApiKey(...)`);
    });
  }
});
