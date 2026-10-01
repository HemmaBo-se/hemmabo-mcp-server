/**
 * Contract test — hemmabo_booking_reschedule moves NO money (Policy 4.A).
 *
 * Anthropic Software Directory Policy 4.A: software that transfers money or
 * executes financial transactions on behalf of users is not accepted. The
 * reschedule tool therefore:
 *   1. Writes the new dates + price to the booking row (under the booking lock).
 *   2. Reports previousPrice / newPrice / delta as amounts in the response.
 *   3. Never calls Stripe — no PaymentIntent for a positive delta, no refund
 *      for a negative delta, even with STRIPE_SECRET_KEY set. The difference
 *      is settled between guest and host outside this tool.
 *
 * Uses a mock Supabase (yields a real quote via the same table shapes
 * lib/pricing.ts reads) and a global.fetch spy that records any outbound call.
 *
 * Run: npx tsx --test src/reschedule-no-money-movement.contract.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { executeTool, type ToolClients } from "../lib/tools.js";

const NEW_CHECK_IN = "2026-09-02";
const NEW_CHECK_OUT = "2026-09-05"; // 3 nights → 1000 + 1000 + 1200 = 3200
const OLD_PRICE = 5000;             // delta = 3200 - 5000 = -1800 (price down)
const LOW_OLD_PRICE = 1000;         // delta = 3200 - 1000 = +2200 (price up)
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

function bookingRow(oldPrice = OLD_PRICE) {
  return {
    id: BOOKING_ID,
    status: "confirmed",
    guest_token: TOKEN,
    check_in_date: "2026-08-01",
    check_out_date: "2026-08-04",
    guests_count: 4,
    total_price: oldPrice,
    currency: "SEK",
    property_id: "p-1",
    stripe_payment_intent_id: "pi_123", // present on the row, must never be used
  };
}

function makeClients(opts: { updateError?: { message: string } | null; lockConflict?: boolean; oldPrice?: number } = {}): ToolClients {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (table: string): any => {
    let updated = false;
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "gte", "lte", "lt", "gt", "or", "neq", "limit", "in", "insert", "delete"]) {
      chain[m] = () => chain;
    }
    chain.update = () => { updated = true; return chain; };
    chain.single = () => {
      if (table === "bookings") return Promise.resolve({ data: bookingRow(opts.oldPrice), error: null });
      if (table === "properties") return Promise.resolve({ data: QUOTE_PROPERTY, error: null });
      if (table === "property_smart_pricing") {
        return Promise.resolve({ data: { gap_fill_enabled: false, gap_fill_min_nights: 2, gap_night_discount_pct: null }, error: null });
      }
      // acquireBookingLock inserts a booking_locks row and reads back its id.
      if (table === "booking_locks") {
        if (opts.lockConflict) { events.push("lock_conflict"); return Promise.resolve({ data: null, error: { code: "23P01" } }); }
        events.push("lock_acquire");
        return Promise.resolve({ data: { id: "lock-1" }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (table === "bookings" && updated) {
        events.push("db_update");
        return Promise.resolve({ data: null, error: opts.updateError ?? null }).then(resolve);
      }
      // releaseBookingLock sets locked_until on the booking_locks row.
      if (table === "booking_locks" && updated) {
        events.push("lock_release");
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      if (table === "property_price_blocks") return Promise.resolve({ data: [BLOCK], error: null }).then(resolve);
      if (table === "property_seasons") return Promise.resolve({ data: [SEASON], error: null }).then(resolve);
      // availability queries, gap-neighbor bookings, lock cleanup, channel/stay discounts → empty
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

describe("reschedule moves no money (Policy 4.A)", () => {
  for (const [label, oldPrice, delta] of [["price down", OLD_PRICE, -1800], ["price up", LOW_OLD_PRICE, 2200]] as const) {
    it(`${label}: updates the booking, reports delta ${delta}, and never calls Stripe`, async () => {
      const result = await executeTool(
        "hemmabo_booking_reschedule",
        { reservationId: BOOKING_ID, guestToken: TOKEN, newCheckIn: NEW_CHECK_IN, newCheckOut: NEW_CHECK_OUT },
        makeClients({ oldPrice }),
      );
      assert.notEqual(result.isError, true, `expected success, got: ${result.content[0]?.text}`);
      assert.ok(events.includes("db_update"), "the booking must be updated");
      assert.ok(!events.includes("stripe_fetch"), `no Stripe call may run (events: ${events.join(" → ")})`);
      assert.equal(fetchCalls.length, 0, "Policy 4.A: no PaymentIntent, no refund");
      const parsed = JSON.parse(result.content[0]?.text ?? "{}");
      assert.equal(parsed.pricing.previousPrice, oldPrice);
      assert.equal(parsed.pricing.newPrice, 3200);
      assert.equal(parsed.pricing.delta, delta, "the difference is reported as an amount");
      assert.equal(parsed.pricing.currency, "SEK");
      assert.ok(!("stripeAction" in parsed.pricing), "no money-movement record in the response");
      assert.doesNotMatch(result.content[0]?.text ?? "", /client_secret|refundId|paymentIntentId/, "no payment artefacts in the response");
    });
  }

  it("makes NO Stripe call when the DB update fails", async () => {
    const result = await executeTool(
      "hemmabo_booking_reschedule",
      { reservationId: BOOKING_ID, guestToken: TOKEN, newCheckIn: NEW_CHECK_IN, newCheckOut: NEW_CHECK_OUT },
      makeClients({ updateError: { message: "db write failed" } }),
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /db write failed/);
    assert.ok(events.includes("db_update"), "the DB update was attempted");
    assert.equal(fetchCalls.length, 0);
  });
});

describe("reschedule availability lock (residual closure)", () => {
  it("lock conflict → refused, no DB update, no Stripe", async () => {
    const result = await executeTool(
      "hemmabo_booking_reschedule",
      { reservationId: BOOKING_ID, guestToken: TOKEN, newCheckIn: NEW_CHECK_IN, newCheckOut: NEW_CHECK_OUT },
      makeClients({ lockConflict: true }),
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /temporarily locked/i);
    assert.ok(events.includes("lock_conflict"), "the lock insert must have conflicted");
    assert.ok(!events.includes("db_update"), "a lock conflict must not write the booking");
    assert.ok(!events.includes("stripe_fetch"), "a lock conflict must not call Stripe");
    assert.equal(fetchCalls.length, 0);
  });

  it("happy path: lock is acquired first and released in finally", async () => {
    const result = await executeTool(
      "hemmabo_booking_reschedule",
      { reservationId: BOOKING_ID, guestToken: TOKEN, newCheckIn: NEW_CHECK_IN, newCheckOut: NEW_CHECK_OUT },
      makeClients(),
    );
    assert.notEqual(result.isError, true, `expected success, got: ${result.content[0]?.text}`);
    assert.equal(events[0], "lock_acquire", "the lock is acquired before any availability/DB work");
    assert.ok(events.includes("lock_release"), "the lock is released in finally");
    assert.ok(events.indexOf("lock_acquire") < events.indexOf("db_update"), "lock precedes the DB write");
    assert.ok(events.indexOf("db_update") < events.indexOf("lock_release"), "lock released after the work completes");
  });
});
