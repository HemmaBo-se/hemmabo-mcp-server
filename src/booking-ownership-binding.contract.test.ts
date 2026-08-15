/**
 * Contract test — per-booking ownership binding (BOLA closure) on the MCP
 * booking tools (hemmabo_booking_cancel / _status / _reschedule).
 *
 * The invariant: a valid Bearer token authenticates the CALLER but is
 * client-scoped, not booking-scoped. Acting on a specific booking additionally
 * requires the booking's own `guest_token`, presented as `guestToken`. Without
 * it — or with the wrong one (e.g. another booking's token) — the call is
 * refused BEFORE any side effect, PII read, or status leak.
 *
 * These tests exercise the real handlers (via executeTool) with a mock
 * Supabase client; no database or network. Stripe/edge calls are stubbed and
 * asserted NOT to run on the reject path.
 *
 * Run: npx tsx --test src/booking-ownership-binding.contract.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { executeTool, type ToolClients } from "../lib/tools.js";
import { bookingTokenMatches, BOOKING_TOKEN_MISMATCH_MESSAGE } from "../lib/booking-binding.js";

const RIGHT = "11111111-1111-1111-1111-111111111111";
const WRONG = "22222222-2222-2222-2222-222222222222"; // another booking's token
const BOOKING_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const MISMATCH_RE = /does not match this booking/i;
const MISSING_RE = /Missing required argument\(s\):/;

// ── Mock Supabase (query-builder + call tracking) ────────────────────────────
function makeClients(opts: {
  booking?: Record<string, unknown> | null;
  blockedRows?: Array<{ start_date: string; end_date: string; source?: string }>;
}): { clients: ToolClients; tablesQueried: string[] } {
  const tablesQueried: string[] = [];
  const resp = (table: string) => {
    if (table === "bookings") {
      return opts.booking
        ? { data: opts.booking, error: null }
        : { data: null, error: { message: "not found" } };
    }
    if (table === "property_blocked_dates") return { data: opts.blockedRows ?? [], error: null };
    return { data: null, error: null };
  };
  const build = (table: string) => {
    tablesQueried.push(table);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {};
    for (const m of ["select", "eq", "lt", "gt", "gte", "lte", "or", "neq", "in", "update", "insert", "delete"]) {
      q[m] = () => q;
    }
    q.single = () => Promise.resolve(resp(table));
    q.maybeSingle = () => Promise.resolve(resp(table));
    q.then = (r: (v: unknown) => unknown) => Promise.resolve(resp(table)).then(r);
    return q;
  };
  const client = { from: build } as unknown as ToolClients["supabase"];
  return { clients: { supabase: client, reader: client }, tablesQueried };
}

function confirmedBooking(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BOOKING_ID,
    status: "confirmed",
    guest_token: RIGHT,
    check_in_date: "2026-09-01",
    check_out_date: "2026-09-04",
    guests_count: 2,
    total_price: 1000,
    currency: "SEK",
    property_id: "3ef1d46d-5c23-46fe-86cb-8e714abf734f",
    guest_name: "Anna Svensson",
    guest_email: "anna@example.com",
    stripe_payment_intent_id: null,
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
    ...extra,
  };
}

// ── Stripe/edge fetch stub ───────────────────────────────────────────────────
let fetchCalls: string[] = [];
let originalFetch: typeof globalThis.fetch;
let savedEnv: Record<string, string | undefined> = {};

before(() => {
  originalFetch = globalThis.fetch;
  savedEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
  // Any outbound call (cancel edge fn, Stripe) resolves ok — but the reject
  // path must never reach here; tests assert fetchCalls stays empty there.
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ refund: null }),
      text: async () => "{}",
    } as Response;
  }) as typeof globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  fetchCalls = [];
});

// ── bookingTokenMatches unit ─────────────────────────────────────────────────
describe("bookingTokenMatches", () => {
  it("true for identical tokens", () => assert.equal(bookingTokenMatches(RIGHT, RIGHT), true));
  it("false for different tokens", () => assert.equal(bookingTokenMatches(RIGHT, WRONG), false));
  it("false for empty presented", () => assert.equal(bookingTokenMatches("", RIGHT), false));
  it("false for missing stored", () => assert.equal(bookingTokenMatches(RIGHT, null), false));
  it("false for non-string", () => assert.equal(bookingTokenMatches(123 as unknown, RIGHT), false));
  it("false on length mismatch", () => assert.equal(bookingTokenMatches("short", RIGHT), false));
  it("trims surrounding whitespace before comparing", () => assert.equal(bookingTokenMatches(` ${RIGHT} `, RIGHT), true));
});

// ── Missing token → rejected before any DB call ──────────────────────────────
describe("missing guestToken is a required-arg error (no DB call)", () => {
  for (const tool of ["hemmabo_booking_cancel", "hemmabo_booking_status", "hemmabo_booking_reschedule"]) {
    it(`${tool} without guestToken → Missing required argument(s): guestToken`, async () => {
      const { clients, tablesQueried } = makeClients({ booking: confirmedBooking() });
      const args =
        tool === "hemmabo_booking_reschedule"
          ? { reservationId: BOOKING_ID, newCheckIn: "2026-10-01", newCheckOut: "2026-10-03" }
          : { reservationId: BOOKING_ID };
      const result = await executeTool(tool, args, clients);
      assert.equal(result.isError, true);
      const text = result.content[0]?.text ?? "";
      assert.match(text, MISSING_RE);
      assert.match(text, /guestToken/);
      assert.equal(tablesQueried.length, 0, "must reject before touching Supabase");
      assert.equal(fetchCalls.length, 0);
    });
  }
});

// ── Wrong / cross-tenant token → refused before side effects ─────────────────
describe("wrong guestToken is refused (BOLA)", () => {
  it("cancel with another booking's token → mismatch, no refund/edge call", async () => {
    const { clients } = makeClients({ booking: confirmedBooking() });
    const result = await executeTool(
      "hemmabo_booking_cancel",
      { reservationId: BOOKING_ID, guestToken: WRONG, reason: "x" },
      clients,
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", MISMATCH_RE);
    assert.equal(fetchCalls.length, 0, "cancel edge function must NOT be called on a token mismatch");
  });

  it("status with wrong token → mismatch, no PII returned", async () => {
    const { clients } = makeClients({ booking: confirmedBooking() });
    const result = await executeTool(
      "hemmabo_booking_status",
      { reservationId: BOOKING_ID, guestToken: WRONG },
      clients,
    );
    assert.equal(result.isError, true);
    const text = result.content[0]?.text ?? "";
    assert.match(text, MISMATCH_RE);
    assert.doesNotMatch(text, /anna/i, "guest PII must not leak on a token mismatch");
  });

  it("reschedule with wrong token → mismatch, never reaches availability/Stripe", async () => {
    const { clients, tablesQueried } = makeClients({ booking: confirmedBooking() });
    const result = await executeTool(
      "hemmabo_booking_reschedule",
      { reservationId: BOOKING_ID, guestToken: WRONG, newCheckIn: "2026-09-10", newCheckOut: "2026-09-12" },
      clients,
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", MISMATCH_RE);
    assert.ok(!tablesQueried.includes("property_blocked_dates"), "must not run availability on a token mismatch");
    assert.equal(fetchCalls.length, 0, "no Stripe charge/refund on a token mismatch");
  });
});

// ── Correct token → passes the binding, proceeds into the flow ───────────────
describe("correct guestToken passes the binding", () => {
  it("cancel proceeds to the cancel-booking edge function", async () => {
    const { clients } = makeClients({ booking: confirmedBooking() });
    const result = await executeTool(
      "hemmabo_booking_cancel",
      { reservationId: BOOKING_ID, guestToken: RIGHT, reason: "guest asked" },
      clients,
    );
    assert.notEqual(result.isError, true, `expected success, got: ${result.content[0]?.text}`);
    assert.match(result.content[0]?.text ?? "", /cancelled/i);
    assert.equal(fetchCalls.length, 1, "the cancel path must reach the edge function exactly once");
  });

  it("status returns the (masked) booking details", async () => {
    const { clients } = makeClients({ booking: confirmedBooking() });
    const result = await executeTool(
      "hemmabo_booking_status",
      { reservationId: BOOKING_ID, guestToken: RIGHT },
      clients,
    );
    assert.notEqual(result.isError, true, `expected success, got: ${result.content[0]?.text}`);
    const text = result.content[0]?.text ?? "";
    assert.match(text, /"status"/);
    assert.doesNotMatch(text, /anna@example\.com/, "email must be masked, not raw");
  });

  it("reschedule passes the binding and reaches availability (proof: not a mismatch)", async () => {
    const { clients, tablesQueried } = makeClients({
      booking: confirmedBooking(),
      // Force the new dates to collide so the flow stops right after the binding
      // with an availability error — proving the binding itself let us through.
      blockedRows: [{ start_date: "2026-09-10", end_date: "2026-09-12" }],
    });
    const result = await executeTool(
      "hemmabo_booking_reschedule",
      { reservationId: BOOKING_ID, guestToken: RIGHT, newCheckIn: "2026-09-10", newCheckOut: "2026-09-12" },
      clients,
    );
    assert.equal(result.isError, true);
    const text = result.content[0]?.text ?? "";
    assert.doesNotMatch(text, MISMATCH_RE, "binding must have passed");
    assert.match(text, /not available/i);
    assert.ok(tablesQueried.includes("property_blocked_dates"), "reached availability past the binding");
    assert.equal(fetchCalls.length, 0, "availability failed first; no Stripe charge/refund");
  });
});

// Keep the imported constant referenced so its wording stays test-locked.
describe("mismatch message is stable", () => {
  it("matches the exported constant", () => assert.match(BOOKING_TOKEN_MISMATCH_MESSAGE, MISMATCH_RE));
});
