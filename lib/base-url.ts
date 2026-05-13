import type { VercelRequest } from "../api/_types.js";

/**
 * Derive this deployment's externally-visible base URL from the incoming
 * request, falling back to a sensible default.
 *
 * Why this exists: hard-coded production URLs (e.g. in the MCP manifest,
 * OAuth registration response, ACP booking links) point preview deploys at
 * prod, breaking integration tests and self-hosted forks. Request-time
 * derivation makes each deployment self-describe correctly.
 *
 * Resolution order:
 *   1. PUBLIC_BASE_URL env (explicit override for self-hosted operators)
 *   2. x-forwarded-proto + x-forwarded-host (Vercel sets these on every req)
 *   3. host header with assumed https
 *   4. https://hemmabo-mcp-server.vercel.app (last-resort prod fallback)
 *
 * Trailing slashes are stripped so callers can safely do `${baseUrl}/foo`.
 */
export function baseUrl(req: VercelRequest): string {
  const override = process.env.PUBLIC_BASE_URL;
  if (override) return override.replace(/\/+$/, "");

  const headers = req.headers ?? {};
  const proto = pickHeader(headers["x-forwarded-proto"]) ?? "https";
  const host =
    pickHeader(headers["x-forwarded-host"]) ?? pickHeader(headers.host);

  if (host) return `${proto}://${host}`;
  return "https://hemmabo-mcp-server.vercel.app";
}

function pickHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
