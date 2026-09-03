/**
 * Per-node Stripe network profile — the host-owned grant target for
 * SharedPaymentToken (SPT) redemption.
 *
 * Source of truth: smart-stays ADR 2026-09-03
 * (docs/DECISIONS/2026-09-03-per-node-stripe-network-profile.md) and the
 * deny-all table `property_stripe_network_settings` it created. The host
 * pastes their OWN Stripe profile id (profile_… / profile_test_…) once in the
 * node dashboard; this module only READS that row. It never calls Stripe to
 * discover a profile (no /v2/network/business_profiles auto-read) and never
 * names HemmaBo's platform profile as the seller.
 *
 * Why the agent needs it: Stripe's Connect SPT flow has the platform hand the
 * agent a "network ID" (the Stripe profile id) BEFORE the token is minted; the
 * agent passes it as seller_details[network_business_profile]. With
 * on_behalf_of destination charges Stripe recommends the connected account's
 * profile — the host's — so the token is bound to the host, never to HemmaBo.
 *
 * Fail closed: no row / malformed row → null → the checkout advertises no
 * network id and a live-mode spt_ is refused for that node. The VRP booking
 * path (signed direct_booking_url on the host domain) is unaffected.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Same rule the smart-stays edge function enforces on write. Defense in depth on read. */
export const STRIPE_NETWORK_PROFILE_ID_RE = /^profile_[A-Za-z0-9_]{6,}$/;

export function isStripeNetworkProfileId(value: unknown): value is string {
  return typeof value === "string" && STRIPE_NETWORK_PROFILE_ID_RE.test(value);
}

/**
 * The node's stored Stripe profile id, or null when none is configured, the
 * stored value is malformed, or the read fails. Service-role client required:
 * the table is deny-all RLS.
 */
export async function readNodeNetworkProfile(
  supabase: SupabaseClient,
  propertyId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("property_stripe_network_settings")
      .select("stripe_network_profile_id")
      .eq("property_id", propertyId)
      .maybeSingle();
    if (error || !data) return null;
    const id = (data as { stripe_network_profile_id?: unknown }).stripe_network_profile_id;
    return isStripeNetworkProfileId(id) ? id : null;
  } catch {
    return null;
  }
}

export type SptRedemptionFailure = "binding_mismatch" | "other";

/**
 * Tells a token bound to the WRONG profile apart from every other Stripe
 * rejection, so the agent gets an actionable answer instead of a generic
 * "Payment failed". Stripe's UCP/SPT error taxonomy names this case
 * `binding_invalid` ("binding mismatch", unrecoverable — re-mint against the
 * expected profile); the message-based fallback covers the PaymentIntent
 * surface should it phrase the same failure without that code. Anything
 * unreadable is "other" — never assume a mismatch.
 */
export function classifySptRedemptionError(stripeJson: unknown): SptRedemptionFailure {
  if (!stripeJson || typeof stripeJson !== "object") return "other";
  const err = (stripeJson as { error?: unknown }).error;
  if (!err || typeof err !== "object") return "other";
  const { code, message, param } = err as { code?: unknown; message?: unknown; param?: unknown };
  if (code === "binding_invalid") return "binding_mismatch";
  const text = `${typeof message === "string" ? message : ""} ${typeof param === "string" ? param : ""}`;
  if (/network_business_profile/i.test(text)) return "binding_mismatch";
  if (/\bbinding\b/i.test(text) && /shared_payment|granted_token|token/i.test(text)) return "binding_mismatch";
  return "other";
}
