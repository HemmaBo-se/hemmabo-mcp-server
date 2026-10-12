// The one switch for agent checkout on this server (S22, CEO order 2026-10-09). The same switch
// and the same answer as hemmabo-smart-stays api/_lib/agent-transactions.js.
//
// Closed, every /acp/* request answers 403 with the text below before auth, the request body, a
// database client or Stripe. Nothing is deleted: api/acp.ts acpRouter is the checkout as it runs
// when the switch is open.
//
// Only the CEO opens it: a pull request that sets this constant to true and changes the pin in
// src/agent-transactions-closed.contract.test.ts, under a new decision that replaces
// hemmabo-smart-stays docs/DECISIONS/2026-10-09-agent-transactions-closed.md. It is code, not an
// environment variable, so no dashboard can open it.
import type { VercelResponse } from "../api/_types.js";

export const AGENT_TRANSACTIONS_ENABLED = false;

export const AGENT_TRANSACTIONS_CLOSED_TEXT = "Agents verify and send the guest to the host's booking page";

export const AGENT_TRANSACTIONS_CLOSED_BODY = Object.freeze({
  error: "agent_transactions_closed",
  message: AGENT_TRANSACTIONS_CLOSED_TEXT,
});

/** First line of a gated handler: `if (agentTransactionsClosed(res)) return;` */
export function agentTransactionsClosed(res: VercelResponse): boolean {
  if (AGENT_TRANSACTIONS_ENABLED) return false;
  res.setHeader("Cache-Control", "no-store");
  res.status(403).json(AGENT_TRANSACTIONS_CLOSED_BODY);
  return true;
}
