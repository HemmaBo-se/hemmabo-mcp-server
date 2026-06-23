import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve package.json from repo root whether the caller runs from source
 * (lib/, api/) or compiled output (dist/lib/, dist/api/).
 */
export function readPackageJson(): { version: string } {
  const require = createRequire(import.meta.url);
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 6; depth++) {
    try {
      return require(join(dir, "package.json")) as { version: string };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
        throw error;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error("Could not locate package.json for version metadata");
}
