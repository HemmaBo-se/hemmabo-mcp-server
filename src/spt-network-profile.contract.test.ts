/**
 * Contract test — the node's own Stripe network profile is the SPT grant
 * target (ADR 0018; smart-stays ADR 2026-09-03).
 *
 * What this locks:
 *   1. readNodeNetworkProfile reads ONLY property_stripe_network_settings,
 *      re-validates the stored value with the same rule the smart-stays edge
 *      function enforces on write, and fails closed (null) on no row, a
 *      malformed row, a read error, or a thrown client.
 *   2. classifySptRedemptionError names a wrong-profile binding and nothing
 *      else — unreadable bodies are "other", never a mismatch.
 *   3. The wiring in api/acp.ts: the checkout advertises the profile as
 *      payment_provider.network_business_profile (and only when configured);
 *      /complete reads it BEFORE the PaymentIntent is created, refuses a
 *      live-mode spt_ for a node with no profile without calling Stripe,
 *      answers a binding mismatch with the expected profile, and never
 *      auto-reads the profile from Stripe.
 *
 * Run: npx tsx --test src/spt-network-profile.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  STRIPE_NETWORK_PROFILE_ID_RE,
  isStripeNetworkProfileId,
  readNodeNetworkProfile,
  classifySptRedemptionError,
} from "../lib/stripe-network-profile.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const acpSource = readFileSync(join(root, "api", "acp.ts"), "utf8");
const libSource = readFileSync(join(root, "lib", "stripe-network-profile.ts"), "utf8");

const VALID = "profile_61VKGsrXTGRgUyDPSA6VKGsr3HQC9br0v49U2y1zcA8O";

/** Minimal service-role client double: records the table/column/filter and answers one row. */
function stubClient(answer: { data: unknown; error: unknown } | (() => never)) {
  const calls: { table?: string; select?: string; eq?: [string, string] } = {};
  const client = {
    from(table: string) {
      calls.table = table;
      return {
        select(cols: string) {
          calls.select = cols;
          return {
            eq(col: string, val: string) {
              calls.eq = [col, val];
              return {
                async maybeSingle() {
                  if (typeof answer === "function") answer();
                  return answer;
                },
              };
            },
          };
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("STRIPE_NETWORK_PROFILE_ID_RE — same rule as the smart-stays edge function", () => {
  it("is the ADR regex", () => {
    assert.equal(STRIPE_NETWORK_PROFILE_ID_RE.source, "^profile_[A-Za-z0-9_]{6,}$");
  });

  it("accepts profile_ / profile_test_ ids and rejects handles, accounts and junk", () => {
    assert.equal(isStripeNetworkProfileId(VALID), true);
    assert.equal(isStripeNetworkProfileId("profile_test_1PxYz9AbCdEf"), true);
    for (const bad of [
      "acct_1TQZDxBRdv1Wi9s9",
      "u_connect_aeacca0963dbe57aa56e",
      "@u_connect_aeacca0963dbe57aa56e",
      "profile_ab",
      "profile-abc123",
      "",
      null,
      undefined,
      42,
      { id: VALID },
    ]) {
      assert.equal(isStripeNetworkProfileId(bad), false, `must reject ${String(bad)}`);
    }
  });
});

describe("readNodeNetworkProfile — reads the deny-all table, fails closed", () => {
  it("returns the stored id and reads only property_stripe_network_settings.stripe_network_profile_id", async () => {
    const { client, calls } = stubClient({ data: { stripe_network_profile_id: VALID }, error: null });
    assert.equal(await readNodeNetworkProfile(client, "prop-1"), VALID);
    assert.equal(calls.table, "property_stripe_network_settings");
    assert.equal(calls.select, "stripe_network_profile_id");
    assert.deepEqual(calls.eq, ["property_id", "prop-1"]);
  });

  it("returns null when the node has no row", async () => {
    const { client } = stubClient({ data: null, error: null });
    assert.equal(await readNodeNetworkProfile(client, "prop-1"), null);
  });

  it("returns null when the stored value is malformed (an acct_, a handle, empty)", async () => {
    for (const stored of ["acct_1TQZDxBRdv1Wi9s9", "u_connect_aeacca0963dbe57aa56e", "", null, 7]) {
      const { client } = stubClient({ data: { stripe_network_profile_id: stored }, error: null });
      assert.equal(await readNodeNetworkProfile(client, "prop-1"), null, `stored ${String(stored)}`);
    }
  });

  it("returns null on a read error or a throwing client — never throws into the checkout", async () => {
    const errored = stubClient({ data: null, error: { message: "permission denied" } });
    assert.equal(await readNodeNetworkProfile(errored.client, "prop-1"), null);
    const throwing = stubClient(() => {
      throw new Error("network down");
    });
    assert.equal(await readNodeNetworkProfile(throwing.client, "prop-1"), null);
  });
});

describe("classifySptRedemptionError — a wrong-profile binding, and nothing else", () => {
  it("names Stripe's binding_invalid code", () => {
    assert.equal(
      classifySptRedemptionError({ error: { code: "binding_invalid", message: "binding mismatch" } }),
      "binding_mismatch",
    );
  });

  it("names a message or param that points at network_business_profile", () => {
    assert.equal(
      classifySptRedemptionError({
        error: { code: "invalid_request_error", message: "The token was granted to a different network_business_profile." },
      }),
      "binding_mismatch",
    );
    assert.equal(
      classifySptRedemptionError({ error: { code: "parameter_invalid", param: "seller_details[network_business_profile]" } }),
      "binding_mismatch",
    );
    assert.equal(
      classifySptRedemptionError({ error: { message: "Invalid binding for shared_payment_granted_token" } }),
      "binding_mismatch",
    );
  });

  it("is 'other' for declines, unrelated errors, and unreadable bodies", () => {
    for (const body of [
      { error: { code: "card_declined", message: "Your card was declined." } },
      { error: { code: "resource_missing", message: "No such shared payment token: spt_x" } },
      { error: { message: "Amount exceeds the token's usage limit" } },
      { error: "binding" },
      { error: null },
      {},
      null,
      "binding_invalid",
      42,
    ]) {
      assert.equal(classifySptRedemptionError(body), "other", JSON.stringify(body));
    }
  });
});

describe("api/acp.ts wiring — advertise before mint, expect at redemption, fail closed", () => {
  it("imports the reader and classifier from lib/stripe-network-profile.js", () => {
    assert.match(acpSource, /from "\.\.\/lib\/stripe-network-profile\.js"/);
  });

  it("the checkout state advertises payment_provider.network_business_profile only when configured", () => {
    assert.match(acpSource, /network_business_profile\?: string;/);
    assert.match(
      acpSource,
      /const networkBusinessProfile = await readNodeNetworkProfile\(supabase, booking\.property_id\);/,
    );
    assert.match(
      acpSource,
      /\.\.\.\(networkBusinessProfile \? \{ network_business_profile: networkBusinessProfile \} : \{\}\)/,
    );
  });

  it("/complete reads the expected profile BEFORE the PaymentIntent is built", () => {
    const read = acpSource.indexOf("const expectedNetworkProfile = await readNodeNetworkProfile(supabase, booking.property_id);");
    const piBuild = acpSource.indexOf("const piBody = new URLSearchParams();");
    const piFetch = acpSource.indexOf('fetch("https://api.stripe.com/v1/payment_intents"');
    assert.ok(read > 0 && piBuild > read && piFetch > piBuild, "read → build → fetch, in that order");
  });

  it("refuses a live-mode spt_ for a node with no profile before calling Stripe (test mode may proceed)", () => {
    assert.match(acpSource, /if \(isSpt && !expectedNetworkProfile && !isTestMode\) \{\s*return res\.status\(409\)\.json\(\{\s*type: "spt_not_enabled_for_node"/);
    const gate = acpSource.indexOf('type: "spt_not_enabled_for_node"');
    const piFetch = acpSource.indexOf('fetch("https://api.stripe.com/v1/payment_intents"');
    assert.ok(gate > 0 && gate < piFetch, "the gate must sit before the Stripe call");
  });

  it("answers a binding mismatch on 402 with the expected profile, and names it on every SPT failure", () => {
    assert.match(acpSource, /const sptFailure = isSpt \? classifySptRedemptionError\(piJson\) : null;/);
    assert.match(acpSource, /type: "spt_binding_mismatch",[\s\S]{0,400}expected_network_business_profile: expectedNetworkProfile,/);
    assert.match(acpSource, /\.\.\.\(isSpt \? \{ expected_network_business_profile: expectedNetworkProfile \} : \{\}\)/);
    // Still a 402 — Stripe took no money and the booking stays pending.
    const mismatch = acpSource.indexOf('type: "spt_binding_mismatch"');
    const before = acpSource.slice(mismatch - 120, mismatch);
    assert.match(before, /res\.status\(402\)\.json\(\{\s*$/);
  });

  it("the root discovery says where the network id lives, and never carries a profile_ itself", () => {
    assert.match(acpSource, /spt_network_id: "payment_provider\.network_business_profile on each checkout/);
    assert.doesNotMatch(acpSource, /profile_[A-Za-z0-9]{6,}/, "no literal profile id in code");
  });

  it("never auto-reads the profile from Stripe — the host pastes it (ADR 2026-09-03 non-goal)", () => {
    const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.doesNotMatch(code(acpSource), /\/v2\/network|business_profiles/);
    assert.doesNotMatch(code(libSource), /api\.stripe\.com|\/v2\/network|business_profiles|fetch\(/);
  });

  it("the redemption shape is unchanged: destination charge to the host, 0% fee, preview header on the SPT branch only", () => {
    assert.match(acpSource, /payment_method_data\[shared_payment_granted_token\]/);
    assert.match(acpSource, /piBody\.append\("application_fee_amount", "0"\)/);
    assert.match(acpSource, /piBody\.append\("on_behalf_of", hostAccountId\)/);
    assert.match(acpSource, /if \(isSpt\)\s*piHeaders\["Stripe-Version"\] = sptApiVersion\(\);/);
  });
});
