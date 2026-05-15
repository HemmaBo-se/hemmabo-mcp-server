/**
 * Contract test: vercel.json must rewrite the two new RFC 8414/9728
 * discovery paths to their handler files, and no static .well-known
 * file may exist that would shadow the rewrite.
 *
 * Without these rewrites, Anthropic Claude.ai's discovery request returns
 * the Vercel 404 HTML page and the connector silently never completes —
 * exact same failure class as the original mcp-manifest dual-SoT bug
 * (#39).
 *
 * Run: npx tsx --test src/oauth-discovery-rewrites.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Rewrite { source: string; destination: string }

function loadRewrites(): Rewrite[] {
  const cfg = JSON.parse(readFileSync(resolve(REPO_ROOT, "vercel.json"), "utf8")) as {
    rewrites?: Rewrite[];
  };
  return cfg.rewrites ?? [];
}

describe("oauth discovery rewrites (RFC 8414 + 9728)", () => {
  it("rewrites /.well-known/oauth-authorization-server → /api/oauth-authorization-server", () => {
    const found = loadRewrites().find(
      (r) =>
        r.source === "/.well-known/oauth-authorization-server" &&
        r.destination === "/api/oauth-authorization-server"
    );
    assert.ok(found, "Missing rewrite for OAuth AS metadata — Anthropic discovery will 404.");
  });

  it("rewrites /.well-known/oauth-protected-resource → /api/oauth-protected-resource", () => {
    const found = loadRewrites().find(
      (r) =>
        r.source === "/.well-known/oauth-protected-resource" &&
        r.destination === "/api/oauth-protected-resource"
    );
    assert.ok(found, "Missing rewrite for OAuth protected-resource metadata.");
  });

  it("has no static .well-known/oauth-authorization-server file that would shadow the rewrite", () => {
    assert.equal(
      existsSync(resolve(REPO_ROOT, ".well-known/oauth-authorization-server")),
      false
    );
  });

  it("has no static .well-known/oauth-protected-resource file that would shadow the rewrite", () => {
    assert.equal(
      existsSync(resolve(REPO_ROOT, ".well-known/oauth-protected-resource")),
      false
    );
  });
});
