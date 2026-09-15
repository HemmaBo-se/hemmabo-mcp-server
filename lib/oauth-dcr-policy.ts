/**
 * Public Dynamic Client Registration policy.
 *
 * Open DCR exists so Claude.ai can complete the connector handshake
 * (ADR 0003). That is not a licence to accept attacker-controlled
 * redirect hosts or to mint client_credentials clients for strangers.
 *
 * MCP draft (2026) deprecates DCR in favour of Client ID Metadata
 * Documents; this file is the interim control while DCR stays live.
 */

/** Hosts public DCR may bind to an authorization_code client. */
export const DCR_REDIRECT_HOSTS = new Set([
  "claude.ai",
  "www.claude.ai",
  "claude.com",
  "www.claude.com",
  "chatgpt.com",
  "www.chatgpt.com",
  "chat.openai.com",
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * Clients created during the 2026-09-15 disclosure probe + verification.
 * is_active=false in Supabase is the durable kill; this list is the
 * deploy-time kill so production stops honouring them without a SQL click.
 */
export const DISABLED_CLIENT_IDS = new Set([
  "hb_463ff2170ee445d094376c445d711a80",
  "hb_07d1c1b4705043cca9634e3cfaa9949d",
  "hb_15e767e747644f35be4aca77254827a8",
  "hb_678dc5d5213043c89b26c7af45a96eec",
  "hb_6a8b7f092a2b4fc9a910b4b4c075b743",
]);

export function isDisabledClientId(clientId: string): boolean {
  return DISABLED_CLIENT_IDS.has(clientId);
}

export function redirectHost(uri: string): string | null {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isDcrRedirectHostAllowed(uri: string): boolean {
  const host = redirectHost(uri);
  return host !== null && DCR_REDIRECT_HOSTS.has(host);
}
