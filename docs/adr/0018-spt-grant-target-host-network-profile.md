# ADR 0018: SPT grant target is the host's own Stripe network profile, advertised per checkout

- Status: Accepted (CEO "bygg för PR2", 2026-09-03)
- Date: 2026-09-03
- Decides for: `api/acp.ts`, `lib/stripe-network-profile.ts`
- Source of truth: smart-stays ADR `2026-09-03-per-node-stripe-network-profile.md`
  (Accepted, `fcf34c0`) and its build (`hemmabo-smart-stays` #2792: table
  `property_stripe_network_settings`, deny-all RLS; edge function
  `stripe-network-settings`; dashboard card).

## Context

Stripe's Connect flow for SharedPaymentTokens (SPT) has the platform hand the
agent a *network ID* — a Stripe profile id (`profile_…`) — before the token is
minted; the agent passes it as `seller_details[network_business_profile]`.
With `on_behalf_of` destination charges Stripe accepts either the platform's
or the connected account's profile and recommends the connected account's.
HemmaBo's doctrine leaves no choice: the host is merchant of record, funds
settle on the host's own account, HemmaBo takes 0 % and must never be named
as the seller. So the grant target is the host's profile.

Until now this server had no notion of which profile belongs to which node.
`/complete` redeemed an `spt_` correctly (destination charge, `on_behalf_of`
the host, `application_fee_amount=0`, preview `Stripe-Version` on the SPT
branch only) but the checkout never told the agent what to mint against, and
a token bound to the wrong profile surfaced as a generic "Payment failed".

The 2026-08-14 test-mode e2e (documented in smart-stays) redeemed an SPT the
test helper minted against its own profile. A live host profile has since
been stored for the first node through the dashboard; every Stripe object of
any live redemption remains unverified until the CEO reads it in the Stripe
Dashboard. Nothing here is "live".

## Decision

1. **Read, never discover.** `lib/stripe-network-profile.ts` reads
   `property_stripe_network_settings.stripe_network_profile_id` for the
   booking's node with the service-role client, re-validates it with the
   same rule the smart-stays edge function enforces on write
   (`/^profile_[A-Za-z0-9_]{6,}$/`), and returns `null` on no row, a
   malformed row, or any error. No call to Stripe, no
   `/v2/network/business_profiles` auto-read — the host pastes the id.
2. **Advertise before mint.** Every checkout state carries
   `payment_provider.network_business_profile` = the node's stored profile,
   and omits the key when none is configured. This is the only place an
   agent gets the network id. The root `/acp` discovery says so
   (`spt_network_id`) and never carries a profile itself.
3. **Expect at redemption.** `/complete` reads the same value before the
   PaymentIntent is built. In live mode an `spt_` for a node with no
   profile is refused with `409 spt_not_enabled_for_node` before Stripe is
   called (token unconsumed, booking pending). Test mode may proceed, as it
   already may without Connect routing, so the composition stays testable.
4. **Name the mismatch.** When Stripe rejects the PaymentIntent and the
   error is a binding mismatch (`binding_invalid`, or a message/param naming
   `network_business_profile` / a token binding), answer
   `402 spt_binding_mismatch` with `expected_network_business_profile` so
   the agent re-mints against the host's profile. Every other SPT failure
   keeps the existing 402 and adds the expected profile. Stripe took no
   money in either case; the booking stays pending.
5. **Unchanged.** The PaymentIntent shape, the preview-version pin, the
   BOLA binding, idempotency, AP2, the ADR 0006/0012 status semantics, the
   VRP surfaces (`payment_options` stays reserved and unpublished), and the
   rule from smart-stays ADR 2026-07-25 that `spt_` redeems on this endpoint
   only.

## Consequences

- Positive: the token is bound to the host, not to HemmaBo, by construction;
  an agent gets an actionable answer on the two failure modes that used to
  read as generic declines; a node opts in simply by pasting its profile.
- Neutral: one extra service-role read per checkout build and per
  `/complete`; the table is deny-all, so this server is the only reader
  besides the host-facing edge function.
- Risk: a host who pastes the wrong profile gets `spt_binding_mismatch` on
  every attempt until corrected — fail closed, no wrong charge, but a silent
  dead path for that node. The dashboard-side check (retrieve the id in
  Workbench) is the control.
- Not verified by this change: the exact Stripe error code a wrong binding
  produces on the PaymentIntent surface. The classifier keys on
  `binding_invalid` (Stripe's documented UCP/SPT taxonomy) plus a
  message/param fallback and treats everything else as "other"; the first
  observed live mismatch should pin the real code in
  `spt-network-profile.contract.test.ts`.

## Verification

`src/spt-network-profile.contract.test.ts`: reader (table, column, filter,
fail-closed cases), classifier table, and source-level wiring (advertise
only when configured; read → build → fetch order; live-mode gate before the
Stripe call; 402 mismatch shape; no `/v2/network` read; redemption shape
unchanged).
