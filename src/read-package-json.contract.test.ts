import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoPkg = createRequire(import.meta.url)("../package.json") as { version: string };

describe("readPackageJson", () => {
  it("resolves package.json from compiled dist/lib path (Glama stdio)", async () => {
    const distLibDir = join(REPO_ROOT, "dist", "lib");
    const moduleUrl = pathToFileURL(join(distLibDir, "read-package-json.js")).href;
    const { readPackageJson } = (await import(moduleUrl)) as {
      readPackageJson: () => { version: string };
    };

    assert.equal(readPackageJson().version, repoPkg.version);
  });
});
