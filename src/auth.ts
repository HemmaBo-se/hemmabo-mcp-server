/**
 * API key validation for MCP and ACP endpoints.
 *
 * When MCP_API_KEY is set in the environment, all POST/PUT requests must carry
 * a matching Bearer token. When unset the check is skipped (open mode), which
 * allows gradual rollout without breaking existing clients.
 */

/**
 * Validates the Bearer token in an Authorization header against MCP_API_KEY.
 *
 * Uses constant-time comparison to prevent timing-based token enumeration.
 * Returns null when the key is valid or MCP_API_KEY is unset.
 * Returns an error string when validation fails.
 */
export function validateApiKey(authHeader: string | undefined): string | null {
  const expectedKey = process.env.MCP_API_KEY;
  if (!expectedKey) return null; // open mode — no key configured

  if (!authHeader) return "Missing Authorization header";

  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

  // Constant-time comparison — prevents timing attacks that could enumerate the key
  if (token.length !== expectedKey.length) return "Invalid API key";
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ expectedKey.charCodeAt(i);
  }
  return mismatch !== 0 ? "Invalid API key" : null;
}
