/**
 * Contract test (C) — hemmabo_booking_reschedule moves money SAFELY.
 *
 * Locks three properties of the reschedule payment path:
 *   1. The bookings.update (new dates + new price) happens BEFORE any Stripe
 *      refund/charge — the DB row is the idempotency anchor.
 *   2. If the DB update fails, NO Stripe call is made at all.
 *   3. The Stripe refund/charge carries a deterministic Idempotency-Key so a
 *      retry or concurrent duplicate collapses to one movement.
 *
 * Uses a mock Supabase (yields a real quote via the same table shapes
 * lib/pricing.ts reads) and a global.fetch spy for Stripe. Ordering is proven
 * by an event log shared between the DB mock and the fetch spy.
 *
 * Run: npx tsx --test src/reschedule-money-order.contract.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { executeTool, type ToolClients } from "../lib/tools.js";

const NEW_CHECK_IN = "2026-09-02";
const NEW_CHECK_OUT = "2026-09-05"; // 3 nights → 1000 + 1000 + 1200 = 3200
const OLD_PRICE = 5000;             // delta = 3200 - 5000 = -1800 → refund
const BOOKING_ID = "b-1";
const TOKEN = "tok-1";

// Ordered log of the money-relevant operations, shared by DB mock + fetch spy.
let events: string[] = [];
let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
let originalFetch: typeof globalThis.fetch;
let savedStripeKey: string | undefined;

const SEASON = { name: "low", date_from: "2026-09-01", date_to: "2026-09-30", type: "low" };
const BLOCK = {
  guests: 6, low_weekday: 1000, low_weekend: 1200, high_weekday: 1500, high_weekend: 1800,
  low_week: null, high_week: null, low_two_weeks: null, high_two_weeks: null,
};
const QUOTE_PROPERTY = {
  id: "p-1", name: "Test Villa", currency: "SEK", max_guests: 8,
  direct_booking_discount: 0, min_nights: 1, max_nights: 30, published: true,
};

function bookingRow() {
  return {
    id: BOOKING_ID,
    status: "confirmed",
    guest_token: TOKEN,
    check_in_date: "2026-08-01",
    check_out_date: "2026-08-04",
    guests_count: 4,
    total_price: OLD_PRICE,
    currency: "SEK",
    property_id: "p-1",
    stripe_payment_intent_id: "pi_123",
  };
}

function makeClients(opts: { updateError?: { message: string } | null } = {}): ToolClients {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (table: string): any => {
    let updated = false;
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "gte", "lte", "lt", "gt", "or", "neq", "limit", "in", "insert", "delete"]) {
      chain[m] = () => chain;
    }
    chain.update = () => { updated = true; return chain; };
    chain.single = () => {
      if (table === "bookings") return Promise.resolve({ data: bookingRow(), error: null });
      if (table === "properties") return Promise.resolve({ data: QUOTE_PROPERTY, error: null });
      if (table === "property_smart_pricing") {
        return Promise.resolve({ data: { gap_fill_enabled: false, gap_fill_min_nights: 2, gap_night_discount_pct: null }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (table === "bookings" && updated) {
        events.push("db_update");
        return Promise.resolve({ data: null, error: opts.updateError ?? null }).then(resolve);
      }
      if (table === "property_price_blocks") return Promise.resolve({ data: [BLOCK], error: null }).then(resolve);
      if (table === "property_seasons") return Promise.resolve({ data: [SEASON], error: null }).then(resolve);
      // availability queries, gap-neighbor bookings, channel/stay discounts → empty
      return Promise.resolve({ data: [], error: null }).then(resolve);
    };
    return chain;
  };
  const client = { from } as unknown as ToolClients["supabase"];
  return { supabase: client, reader: client };
}

before(() => {
  originalFetch = globalThis.fetch;
  savedStripeKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    events.push("stripe_fetch");
    fetchCalls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "re_1", amount: 180000, status: "succeeded" }),
      text: async () => "{}",
    } as Response;
  }) as typeof globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  if (savedStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = savedStripeKey;
});

beforeEach(() => {
  events = [];
  fetchCalls = [];
});

describe("reschedule money ordering (C)", () => {
  it("writes the DB update BEFORE the Stripe refund", async () => {
    const result = await executeTool(
      "hemmabo_booking_reschedule",
      { reservationId: BOOKING_ID, guestToken: TOKEN, newCheckIn: NEW_CHECK_IN, newCheckOut: NEW_CHECK_OUT },
      makeClients(),
    );
    assert.notEqual(result.isError, true, `expected success, got: ${result.content[0]?.text}`);
    const dbIdx = events.indexOf("db_update");
    const stripeIdx = events.indexOf("stripe_fetch");
    assert.ok(dbIdx >= 0, "the booking must be updated");
    assert.ok(stripeIdx >= 0, "a refund must be issued for the negative delta");
    assert.ok(dbIdx < stripeIdx, `DB update must precede Stripe (events: ${events.join(" → ")})`);
  });

  it("sends a deterministic Idempotency-Key on the refund", async () => {
    await executeTool(
      "hemmabo_booking_reschedule",
      { reservationId: BOOKING_ID, guestToken: TOKEN, newCheckIn: NEW_CHECK_IN, newCheckOut: NEW_CHECK_OUT },
      makeClients(),
    );
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /\/v1\/refunds$/);
    assert.equal(
      fetchCalls[0].headers["Idempotency-Key"],
      `reschedule_${BOOKING_ID}_refund_1800_${NEW_CHECK_IN}_${NEW_CHECK_OUT}`,
    );
  });

  it("makes NO Stripe call when the DB update fails (fail-closed on money)", async () => {
    const result = await executeTool(
      "hemmabo_booking_reschedule",
      { reservationId: BOOKING_ID, guestToken: TOKEN, newCheckIn: NEW_CHECK_IN, newCheckOut: NEW_CHECK_OUT },
      makeClients({ updateError: { message: "db write failed" } }),
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /db write failed/);
    assert.ok(events.includes("db_update"), "the DB update was attempted first");
    assert.ok(!events.includes("stripe_fetch"), "no refund/charge may run after a failed DB write");
    assert.equal(fetchCalls.length, 0);
  });
});
