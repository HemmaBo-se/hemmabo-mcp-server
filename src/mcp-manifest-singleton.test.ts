/**
 * Drift-skydd: säkerställer att mcp-discovery-manifestet har EN single source
 * of truth (api/mcp-manifest.ts) och att en framtida PR inte oavsiktligt
 * återinför den statiska .well-known/mcp.json-filen som tidigare orsakade
 * dual-SoT-drift (PR #39 / fix/mcp-manifest-single-sot).
 *
 * Run: npx tsx --test src/mcp-manifest-singleton.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("mcp-manifest singleton", () => {
  it("(a) has no static .well-known/mcp.json file in repo root", () => {
    const staticPath = resolve(REPO_ROOT, ".well-known/mcp.json");
    assert.equal(
      existsSync(staticPath),
      false,
      "A static .well-known/mcp.json file would shadow the Vercel rewrite to /api/mcp-manifest and re-introduce dual-SoT drift. Delete the file and let the handler be the single source of truth."
    );
  });

  it("(b) keeps the vercel.json rewrite from /.well-known/mcp.json to /api/mcp-manifest", () => {
    const vercelPath = resolve(REPO_ROOT, "vercel.json");
    const cfg = JSON.parse(readFileSync(vercelPath, "utf8")) as {
      rewrites?: { source: string; destination: string }[];
    };
    const rewrites = cfg.rewrites ?? [];
    const found = rewrites.find(
      (r) => r.source === "/.well-known/mcp.json" && r.destination === "/api/mcp-manifest"
    );
    assert.ok(
      found,
      "vercel.json must rewrite '/.well-known/mcp.json' → '/api/mcp-manifest' so the handler serves the manifest."
    );
  });

  it("(c) /api/mcp-manifest exports a default function", async () => {
    const mod = await import("../api/mcp-manifest.js");
    assert.equal(typeof mod.default, "function", "mcp-manifest.ts must default-export a Vercel handler function.");
  });

  it("(d) handler runtime output contains all required manifest fields (regression guard)", async () => {
    const mod = await import("../api/mcp-manifest.js");
    const captured: Record<string, unknown> = {};
    const fakeRes = {
      setHeader: () => {},
      json: (body: Record<string, unknown>) => Object.assign(captured, body),
    };
    await mod.default({} as never, fakeRes as never);

    // Pre-existing fields (must not be dropped)
    const baseFields = [
      "schema_version",
      "protocol",
      "protocol_version",
      "name",
      "description",
      "mcp_endpoint",
      "transport",
      "homepage",
      "icon",
      "registry",
      "tools",
      "authentication",
    ];
    // Fields migrated from the deleted static .well-known/mcp.json
    const migratedFields = ["version", "trust"];
    // ChatGPT Apps directory fields added in PR #39
    const directoryFields = [
      "developer",
      "privacy_policy_url",
      "terms_of_service_url",
      "categories",
      "safety_disclosures",
      "sample_prompts",
    ];

    for (const f of [...baseFields, ...migratedFields, ...directoryFields]) {
      assert.ok(
        captured[f] !== undefined && captured[f] !== null,
        `Manifest is missing required field: ${f}`
      );
    }

    // version must come from package.json (single source of truth)
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    assert.equal(captured.version, pkg.version, "manifest.version must match package.json.version");

    // trust must keep its three legacy fields
    const trust = captured.trust as Record<string, unknown>;
    assert.equal(trust.payment, "Stripe (direct to host)");
    assert.equal(trust.commission, "0%");
    assert.equal(trust.data_ownership, "host");
  });
});
