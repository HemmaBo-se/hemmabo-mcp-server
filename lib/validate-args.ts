/**
 * JSON-Schema validation for tool arguments at the HTTP dispatcher layer.
 *
 * Why a separate layer when lib/tools.ts already validates required args:
 *   - lib/tools.ts only checks presence (closes the prod 22P02 bug from #47).
 *   - This module checks types, formats, ranges, and enums per inputSchema —
 *     so an AI agent that passes guests:"six" or guests:-1 gets a clear
 *     field-level error instead of a Supabase coercion failure or silent
 *     bad-data result.
 *
 * Source of truth is TOOLS[].inputSchema in api/mcp.ts. Validators are
 * compiled once at module load — fast path on every tools/call.
 *
 * Defense-in-depth: lib/tools.ts continues to enforce required args even if
 * this layer is bypassed.
 */

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

const ajv = new Ajv({
  allErrors: true,         // collect every validation problem in one pass
  strict: false,           // tolerate the slightly loose JSON-Schema we use
  coerceTypes: false,      // do NOT coerce — "six" must NOT pass as 6
  useDefaults: false,
  removeAdditional: false,
});
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;
addFormats(ajv);

const compiledByTool = new Map<string, ValidateFunction>();

export interface ToolDescriptor {
  name: string;
  inputSchema: object;
}

/**
 * Pre-compile validators for every tool. Idempotent — calling twice with the
 * same name is a no-op. Call once at module load with the canonical TOOLS array.
 */
export function registerToolSchemas(tools: readonly ToolDescriptor[]): void {
  for (const t of tools) {
    if (!compiledByTool.has(t.name)) {
      try {
        compiledByTool.set(t.name, ajv.compile(t.inputSchema));
      } catch (e) {
        // Compilation failure is a developer mistake — fail loudly so it
        // surfaces in CI rather than silently disabling validation in prod.
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to compile inputSchema for tool '${t.name}': ${msg}`);
      }
    }
  }
}

export interface FieldError {
  /** JSON Pointer-ish path, e.g. "/guests" or "/propertyIds/0". */
  path: string;
  /** Human-readable message. */
  message: string;
}

export interface ValidateArgsResult {
  ok: boolean;
  errors?: FieldError[];
}

/**
 * Validate `args` against the registered schema for `toolName`.
 *
 * Returns { ok: true } when:
 *   - no schema is registered for `toolName` (forwards-compatibility — a new
 *     tool added at runtime is still callable; lib/tools.ts will catch missing
 *     required fields, and unknown names are already rejected upstream).
 *   - the schema accepts the args.
 */
export function validateToolArgs(
  toolName: string,
  args: unknown
): ValidateArgsResult {
  const validator = compiledByTool.get(toolName);
  if (!validator) return { ok: true };

  const ok = validator(args ?? {});
  if (ok) return { ok: true };

  const errors = (validator.errors ?? []).map(formatError);
  return { ok: false, errors };
}

function formatError(err: ErrorObject): FieldError {
  // ajv uses "instancePath" like "/guests"; missing-property errors live on
  // the parent path with `params.missingProperty`. Surface a stable path
  // either way so clients can map errors to fields.
  const missing = (err.params as { missingProperty?: string } | undefined)?.missingProperty;
  if (err.keyword === "required" && missing) {
    return {
      path: err.instancePath ? `${err.instancePath}/${missing}` : `/${missing}`,
      message: `must have required property '${missing}'`,
    };
  }
  return {
    path: err.instancePath || "/",
    message: err.message ?? "invalid value",
  };
}

/** Test-only helper. Reset compiled validators between test files. */
export function _resetForTests(): void {
  compiledByTool.clear();
}
