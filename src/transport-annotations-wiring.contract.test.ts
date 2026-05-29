import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRANSPORTS = ["src/index.ts", "src/stdio.ts"] as const;

describe("transport annotation wiring contract", () => {
  for (const file of TRANSPORTS) {
    it(`${file} forwards spec.annotations into server.tool()`, () => {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");

      assert.match(
        source,
        /server\.tool\(\s*spec\.name,\s*spec\.description,\s*shape,\s*spec\.annotations,/,
        `${file} must call server.tool(spec.name, spec.description, shape, spec.annotations, handler)`
      );

      assert.match(
        source,
        /\.tool\s*=\s*\([\s\S]*?annotations:\s*unknown,[\s\S]*?\)\s*=>/,
        `${file} server.tool wrapper must declare an annotations parameter`
      );
      assert.match(
        source,
        /\(name,\s*description,\s*schema,\s*annotations,\s*wrapped\)/,
        `${file} wrapper must forward annotations to the original server.tool`
      );
    });
  }
});
