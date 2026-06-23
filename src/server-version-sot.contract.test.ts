import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_VERSION } from "../lib/server-metadata.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("server version single source of truth", () => {
  it("SERVER_VERSION comes from package.json", () => {
    assert.equal(SERVER_VERSION, pkg.version);
  });

  it("project.faf package metadata matches package.json", () => {
    const projectFaf = readFileSync(resolve(REPO_ROOT, "project.faf"), "utf8");
    assert.match(
      projectFaf,
      new RegExp(`\\r?\\n\\s+version: "${pkg.version.replaceAll(".", "\\.")}"\\r?\\n`),
      "project.faf project.version must match package.json.version",
    );
  });

  it("runtime files do not hardcode package-version literals", () => {
    const files = [
      "api/health.ts",
      "api/mcp.ts",
      "lib/tools-base.ts",
      "lib/server-metadata.ts",
    ];

    for (const file of files) {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      assert.doesNotMatch(
        source,
        /\b(?:version|source_version|SERVER_VERSION|VERSION)\s*[:=]\s*"3\.\d+\.\d+"/,
        `${file} must use SERVER_VERSION/package.json instead of a hardcoded package version`,
      );
    }
  });
});
