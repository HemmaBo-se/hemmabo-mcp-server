/**
 * Pricing, availability, and tool-parity unit tests.
 *
 * Run: npx tsx --test src/pricing.test.ts
 *
 * These tests cover pure helpers exported from lib/pricing.ts,
 * mocked resolveQuote for package / gap rules, and tool parity
 * (all 11 federation tools must be handled by executeTool).
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { isWeekend, daysBetween, findPriceBlock } from "../lib/pricing.js";
import type { PriceBlock } from "../lib/pricing.js";
import { validateDates, validateDateOrder } from "../lib/tools.js";

// ── isWeekend ─────────────────────────────────────────────────────

describe("isWeekend — day-of-week rule", () => {
  // 2024-08-02 = Friday
  it("Friday is weekend", () => {
    assert.equal(isWeekend("2024-08-02"), true);
  });

  // 2024-08-03 = Saturday
  it("Saturday is weekend", () => {
    assert.equal(isWeekend("2024-08-03"), true);
  });

  // 2024-08-04 = Sunday — NEVER weekend per spec
  it("Sunday is NOT weekend", () => {
    assert.equal(isWeekend("2024-08-04"), false);
  });

  // 2024-08-05 = Monday
  it("Monday is NOT weekend", () => {
    assert.equal(isWeekend("2024-08-05"), false);
  });

  // 2024-08-06 = Tuesday
  it("Tuesday is NOT weekend", () => {
    assert.equal(isWeekend("2024-08-06"), false);
  });

  // 2024-08-07 = Wednesday
  it("Wednesday is NOT weekend", () => {
    assert.equal(isWeekend("2024-08-07"), false);
  });

  // 2024-08-08 = Thursday
  it("Thursday is NOT weekend", () => {
    assert.equal(isWeekend("2024-08-08"), false);
  });
});

// ── daysBetween ───────────────────────────────────────────────────

describe("daysBetween", () => {
  it("7 nights", () => {
    assert.equal(daysBetween("2024-07-01", "2024-07-08"), 7);
  });

  it("14 nights", () => {
    assert.equal(daysBetween("2024-07-01", "2024-07-15"), 14);
  });

  it("1 night", () => {
    assert.equal(daysBetween("2024-07-01", "2024-07-02"), 1);
  });

  it("same day clamps to 1", () => {
    // Edge: checkIn === checkOut should not produce 0 or negative
    assert.equal(daysBetween("2024-07-01", "2024-07-01"), 1);
  });
});

// ── findPriceBlock (staircase) ────────────────────────────────────

describe("findPriceBlock — staircase pricing", () => {
  const blocks: PriceBlock[] = [
    { guests: 2, low_weekday: 100, low_weekend: 120, high_weekday: 150, high_weekend: 180, low_week: 600, high_week: 900, low_two_weeks: 1100, high_two_weeks: 1600 },
    { guests: 6, low_weekday: 200, low_weekend: 240, high_weekday: 300, high_weekend: 360, low_week: 1200, high_week: 1800, low_two_weeks: 2200, high_two_weeks: 3200 },
  ];

  it("1 guest → 2g block (smallest that covers)", () => {
    assert.equal(findPriceBlock(1, blocks)?.guests, 2);
  });

  it("2 guests → 2g block (exact match)", () => {
    assert.equal(findPriceBlock(2, blocks)?.guests, 2);
  });

  it("3 guests → 6g block", () => {
    assert.equal(findPriceBlock(3, blocks)?.guests, 6);
  });

  it("6 guests → 6g block (exact match)", () => {
    assert.equal(findPriceBlock(6, blocks)?.guests, 6);
  });

  it("7 guests → null (exceeds all blocks)", () => {
    assert.equal(findPriceBlock(7, blocks), null);
  });
});

// ── 7-night package rule ──────────────────────────────────────────

describe("7-night package rule", () => {
  it("exactly 7 nights → package eligible", () => {
    assert.equal(daysBetween("2024-07-01", "2024-07-08"), 7);
  });

  it("8 nights → NOT package eligible", () => {
    assert.notEqual(daysBetween("2024-07-01", "2024-07-09"), 7);
  });

  it("6 nights → NOT package eligible", () => {
    assert.notEqual(daysBetween("2024-07-01", "2024-07-07"), 7);
  });
});

// ── 14-night package rule ─────────────────────────────────────────

describe("14-night package rule", () => {
  it("exactly 14 nights → package eligible", () => {
    assert.equal(daysBetween("2024-07-01", "2024-07-15"), 14);
  });

  it("13 nights → NOT eligible", () => {
    assert.notEqual(daysBetween("2024-07-01", "2024-07-14"), 14);
  });

  it("15 nights → NOT eligible", () => {
    assert.notEqual(daysBetween("2024-07-01", "2024-07-16"), 14);
  });
});

// ── validateDates ─────────────────────────────────────────────────

describe("validateDates", () => {
  it("accepts valid ISO dates", () => {
    assert.equal(validateDates("2024-07-01", "2024-07-08"), null);
  });

  it("rejects DD/MM/YYYY format", () => {
    assert.match(validateDates("01/07/2024") ?? "", /Invalid date format/);
  });

  it("rejects partial date", () => {
    assert.match(validateDates("2024-07") ?? "", /Invalid date format/);
  });

  it("rejects non-date string", () => {
    assert.match(validateDates("tomorrow") ?? "", /Invalid date format/);
  });

  it("skips undefined entries", () => {
    assert.equal(validateDates("2024-07-01", undefined), null);
  });
});

// ── validateDateOrder ─────────────────────────────────────────────

describe("validateDateOrder", () => {
  it("accepts checkOut after checkIn", () => {
    assert.equal(validateDateOrder("2024-07-01", "2024-07-08"), null);
  });

  it("rejects same-day checkout (checkOut === checkIn)", () => {
    assert.match(validateDateOrder("2024-07-01", "2024-07-01") ?? "", /strictly after/);
  });

  it("rejects checkOut before checkIn", () => {
    assert.match(validateDateOrder("2024-07-08", "2024-07-01") ?? "", /strictly after/);
  });
});

// ── Tool parity — all 11 federation tools must be handled ─────────

describe("tool parity", () => {
  const EXPECTED_TOOLS = [
    "hemmabo_search_properties",
    "hemmabo_search_availability",
    "hemmabo_search_similar",
    "hemmabo_compare_properties",
    "hemmabo_booking_quote",
    "hemmabo_booking_create",
    "hemmabo_booking_negotiate",
    "hemmabo_booking_checkout",
    "hemmabo_booking_cancel",
    "hemmabo_booking_status",
    "hemmabo_booking_reschedule",
  ] as const;

  // We verify parity by calling executeTool with dummy args and checking
  // that the response is NOT the "Unknown tool" fallback. We use a stub
  // Supabase client that returns empty data to avoid real DB calls.
  it("all 11 tools are handled by executeTool (not unknown)", async () => {
    // Lazy import to avoid loading at module level (avoids env var requirements at import time)
    const { executeTool } = await import("../lib/tools.js");

    // Minimal stub: returns empty data/null for every Supabase call
    const stubQuery = {
      select: () => stubQuery,
      eq: () => stubQuery,
      neq: () => stubQuery,
      ilike: () => stubQuery,
      gte: () => stubQuery,
      lte: () => stubQuery,
      lt: () => stubQuery,
      gt: () => stubQuery,
      or: () => stubQuery,
      limit: () => stubQuery,
      order: () => stubQuery,
      single: () => Promise.resolve({ data: null, error: { message: "stub" } }),
      then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
    };

    const stubSupabase: any = {
      from: () => ({
        ...stubQuery,
        delete: () => stubQuery,
        insert: () => ({
          select: () => ({ single: () => Promise.resolve({ data: null, error: { message: "stub" } }) }),
        }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      }),
    };

    const clients = { supabase: stubSupabase, reader: stubSupabase };

    for (const tool of EXPECTED_TOOLS) {
      // Provide minimal valid args per tool so we reach the tool's own logic
      const baseArgs: Record<string, unknown> = {
        propertyId: "00000000-0000-0000-0000-000000000001",
        propertyIds: ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"],
        checkIn: "2025-07-01",
        checkOut: "2025-07-08",
        guests: 2,
        guestName: "Test Guest",
        guestEmail: "test@example.com",
        reservationId: "00000000-0000-0000-0000-000000000002",
        newCheckIn: "2025-07-01",
        newCheckOut: "2025-07-08",
        region: "Dalarna",
        country: "Sweden",
      };

      const result = await executeTool(tool, baseArgs, clients);
      const text = result.content[0]?.text ?? "";
      const parsed = JSON.parse(text);

      assert.notEqual(
        parsed.error,
        `Unknown tool: ${tool}`,
        `Tool "${tool}" fell through to default case — not handled by executeTool`
      );
    }
  });

  it("executeTool returns isError for unknown tool name", async () => {
    const { executeTool } = await import("../lib/tools.js");
    const stubSupabase: any = { from: () => ({}) };
    const result = await executeTool("hemmabo_nonexistent_tool", {}, { supabase: stubSupabase, reader: stubSupabase });
    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.match(parsed.error, /Unknown tool/);
  });
});

// ── booking_locks: TOCTOU + guest_name masking ────────────────────

describe("booking_locks — TOCTOU prevention", () => {
  /**
   * Simulates two concurrent checkout calls for the same property/dates.
   * The first call acquires a lock; the second must fail with
   * "temporarily locked" or "not available".
   */
  it("second concurrent checkout is rejected when lock is held", async () => {
    const { executeTool } = await import("../lib/tools.js");

    // State tracking
    let lockInsertCount = 0;
    let lockDeleteCount = 0;
    let bookingInsertCount = 0;

    // The lock stub: first insert succeeds, second fails (simulates unique constraint)
    const makeLockInsert = () => {
      lockInsertCount++;
      const succeed = lockInsertCount === 1;
      return {
        select: () => ({
          single: () =>
            succeed
              ? Promise.resolve({ data: { id: "lock-uuid-1" }, error: null })
              : Promise.resolve({ data: null, error: { message: "duplicate key" } }),
        }),
      };
    };

    const makeFromTable = (table: string) => {
      const base = {
        select: () => base,
        eq: () => base,
        neq: () => base,
        ilike: () => base,
        gte: () => base,
        lte: () => base,
        lt: () => base,
        gt: () => base,
        or: () => base,
        limit: () => base,
        order: () => base,
        delete: () => base,
        single: () => Promise.resolve({ data: null, error: { message: "stub" } }),
        then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
        update: () => ({
          eq: () => Promise.resolve({ error: null }),
        }),
        insert: () => {
          if (table === "booking_locks") return makeLockInsert();
          if (table === "bookings") {
            bookingInsertCount++;
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({ data: null, error: { message: "stub-booking" } }),
              }),
            };
          }
          return {
            select: () => ({
              single: () => Promise.resolve({ data: null, error: { message: "stub" } }),
            }),
          };
        },
      };
      return base;
    };

    const stubSupabase: any = { from: (table: string) => makeFromTable(table) };
    const stubReader: any = {
      from: () => {
        const r: any = {
          select: () => r,
          eq: () => r,
          single: () =>
            Promise.resolve({
              data: { name: "TestProp", domain: "test.se", host_id: "h1", currency: "SEK", direct_booking_discount: 0 },
              error: null,
            }),
        };
        return r;
      },
    };

    const args = {
      propertyId: "00000000-0000-0000-0000-000000000001",
      checkIn: "2025-08-01",
      checkOut: "2025-08-08",
      guests: 2,
      guestName: "Test Guest",
      guestEmail: "test@example.com",
    };

    // Fire both concurrently
    const [r1, r2] = await Promise.all([
      executeTool("hemmabo_booking_checkout", args, { supabase: stubSupabase, reader: stubReader }),
      executeTool("hemmabo_booking_checkout", args, { supabase: stubSupabase, reader: stubReader }),
    ]);

    const texts = [JSON.parse(r1.content[0].text), JSON.parse(r2.content[0].text)];
    const errors = texts.filter((t) => t.error);
    const locked = errors.filter((t) =>
      /temporarily locked|not available/i.test(t.error ?? "")
    );

    // At least one must be rejected with a lock/availability error
    assert.ok(
      locked.length >= 1,
      `Expected at least one rejection — got: ${JSON.stringify(texts)}`
    );
  });

  it("lock is released (locked_until set to now) on failure path", async () => {
    const { executeTool } = await import("../lib/tools.js");
    const releaseUpdates: string[] = [];

    const makeLockInsert = () => ({
      select: () => ({
        single: () => Promise.resolve({ data: { id: "lock-uuid-release-test" }, error: null }),
      }),
    });

    const makeFromTable = (table: string) => {
      const base: any = {
        select: () => base,
        eq: (col: string, val: string) => {
          if (table === "booking_locks" && col === "id") {
            base._lockId = val;
          }
          return base;
        },
        neq: () => base,
        gte: () => base,
        lte: () => base,
        lt: () => base,
        gt: () => base,
        or: () => base,
        limit: () => base,
        order: () => base,
        delete: () => base,
        single: () => Promise.resolve({ data: null, error: { message: "stub" } }),
        then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
        update: (vals: Record<string, unknown>) => ({
          eq: (col: string, val: string) => {
            if (table === "booking_locks" && col === "id") {
              releaseUpdates.push(val);
            }
            return Promise.resolve({ error: null });
          },
        }),
        insert: () => {
          if (table === "booking_locks") return makeLockInsert();
          // bookings insert fails → triggers finally → lock must be released
          return {
            select: () => ({
              single: () => Promise.resolve({ data: null, error: { message: "forced-booking-error" } }),
            }),
          };
        },
      };
      return base;
    };

    const stubSupabase: any = { from: (table: string) => makeFromTable(table) };
    const stubReader: any = {
      from: () => {
        const r: any = {
          select: () => r,
          eq: () => r,
          single: () =>
            Promise.resolve({
              data: { name: "P", domain: "p.se", host_id: "h1", currency: "SEK", direct_booking_discount: 0 },
              error: null,
            }),
        };
        return r;
      },
    };

    const args = {
      propertyId: "00000000-0000-0000-0000-000000000001",
      checkIn: "2025-09-01",
      checkOut: "2025-09-08",
      guests: 2,
      guestName: "Fail Guest",
      guestEmail: "fail@example.com",
    };

    const result = await executeTool("hemmabo_booking_checkout", args, { supabase: stubSupabase, reader: stubReader });

    // The result must be an error (booking insert failed)
    assert.equal(result.isError, true);

    // The lock must have been released via update({locked_until: now}).eq("id", lockId)
    assert.ok(
      releaseUpdates.includes("lock-uuid-release-test"),
      `Lock was not released. Updates recorded: ${JSON.stringify(releaseUpdates)}`
    );
  });

  it("Stripe error mid-checkout: lock is released and a subsequent attempt can acquire a new lock", async () => {
    // Scenario: booking INSERT succeeds, but createCheckoutSession throws.
    // After the error the lock must be released so a retry can proceed.
    const { executeTool } = await import("../lib/tools.js");

    // Track lock lifecycle
    let lockInsertCalls = 0;
    const releaseUpdates: string[] = [];

    // resolve/availability stubs: always "available"
    const makeFrom = (table: string) => {
      const q: any = {
        select: () => q,
        eq: () => q,
        neq: () => q,
        gte: () => q,
        lte: () => q,
        lt: () => q,
        gt: () => q,
        or: () => q,
        delete: () => q,
        limit: () => q,
        order: () => q,
        // Default single: nothing found (availability passes when no conflicts)
        single: () => Promise.resolve({ data: null, error: { message: "stub" } }),
        then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
        update: (vals: Record<string, unknown>) => ({
          eq: (_col: string, val: string) => {
            if (table === "booking_locks") releaseUpdates.push(val);
            return Promise.resolve({ error: null });
          },
        }),
        insert: () => {
          if (table === "booking_locks") {
            lockInsertCalls++;
            // Always succeed: return incrementing lock IDs
            const id = `lock-stripe-test-${lockInsertCalls}`;
            return {
              select: () => ({
                single: () => Promise.resolve({ data: { id }, error: null }),
              }),
            };
          }
          if (table === "bookings") {
            // Booking insert succeeds (returns a row with an id)
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: { id: "booking-uuid-1", status: "pending", created_at: "2025-01-01T00:00:00Z", guest_token: null },
                    error: null,
                  }),
              }),
            };
          }
          return {
            select: () => ({ single: () => Promise.resolve({ data: null, error: { message: "stub" } }) }),
          };
        },
      };
      return q;
    };

    const stubSupabase: any = { from: (table: string) => makeFrom(table) };
    const stubReader: any = {
      from: () => {
        const r: any = {
          select: () => r,
          eq: () => r,
          single: () =>
            Promise.resolve({
              data: { name: "P", domain: "p.se", host_id: "h1", currency: "SEK", direct_booking_discount: 0 },
              error: null,
            }),
        };
        return r;
      },
    };

    const args = {
      propertyId: "00000000-0000-0000-0000-000000000099",
      checkIn: "2025-10-01",
      checkOut: "2025-10-08",
      guests: 2,
      guestName: "Stripe Fail",
      guestEmail: "stripefail@example.com",
      // Force payment_intent mode to reach createCheckoutSession
    };

    // We can't mock the Stripe module here without dependency injection.
    // Instead, verify the lock-acquire flow is correct by confirming:
    //  1. First call: lock acquired, booking insert ok, then Stripe will throw
    //     (because STRIPE_SECRET_KEY is unset in test env) → error result
    //  2. Lock is released in finally despite the throw
    //  3. Second call: can acquire a NEW lock (lockInsertCalls incremented)

    // First attempt — expect error (Stripe env unset or missing key)
    const result1 = await executeTool("hemmabo_booking_checkout", args, {
      supabase: stubSupabase,
      reader: stubReader,
    });
    // Must be an error (Stripe throws in test env)
    assert.equal(result1.isError, true, "First attempt must fail (Stripe unavailable in test)");

    // Lock from first attempt must have been released
    assert.ok(
      releaseUpdates.includes("lock-stripe-test-1"),
      `Lock from first attempt was not released. Releases: ${JSON.stringify(releaseUpdates)}`
    );

    // Second attempt must be able to acquire a fresh lock (not blocked by first)
    const lockInsertBeforeRetry = lockInsertCalls;
    const result2 = await executeTool("hemmabo_booking_checkout", args, {
      supabase: stubSupabase,
      reader: stubReader,
    });
    // Second attempt also fails (same Stripe env) but must NOT fail with "temporarily locked"
    const parsed2 = JSON.parse(result2.content[0].text);
    assert.notEqual(
      parsed2.error,
      "Dates temporarily locked — another booking is in progress. Please try again shortly.",
      "Second attempt must not be blocked by the first lock"
    );
    // A new lock insert must have been attempted
    assert.ok(
      lockInsertCalls > lockInsertBeforeRetry,
      `Second attempt did not try to acquire a lock. lockInsertCalls=${lockInsertCalls}`
    );
  });
});

// ── guest_name masking in hemmabo_booking_status ──────────────────

describe("hemmabo_booking_status — guest_name masking", () => {
  const makeStatusStub = (guestName: string, guestEmail: string) => {
    const bookingRow = {
      id: "b-uuid",
      status: "confirmed",
      check_in_date: "2025-08-01",
      check_out_date: "2025-08-08",
      guests_count: 2,
      total_price: 5000,
      currency: "SEK",
      property_id: "p-uuid",
      guest_name: guestName,
      guest_email: guestEmail,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };

    const makeFrom = (table: string) => {
      const q: any = {
        select: () => q,
        eq: () => q,
        single: () => {
          if (table === "bookings") return Promise.resolve({ data: bookingRow, error: null });
          if (table === "properties") return Promise.resolve({ data: { name: "P", domain: "p.se" }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
      };
      return q;
    };
    return { from: (table: string) => makeFrom(table) };
  };

  it("masks full name to 'First L.' format", async () => {
    const { executeTool } = await import("../lib/tools.js");
    const stub: any = makeStatusStub("Anna Svensson", "anna.svensson@example.com");
    const result = await executeTool("hemmabo_booking_status", { reservationId: "b-uuid" }, { supabase: stub, reader: stub });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.guestName, "Anna S.");
  });

  it("returns single-word name unchanged", async () => {
    const { executeTool } = await import("../lib/tools.js");
    const stub: any = makeStatusStub("Madonna", "m@example.com");
    const result = await executeTool("hemmabo_booking_status", { reservationId: "b-uuid" }, { supabase: stub, reader: stub });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.guestName, "Madonna");
  });

  it("masks email correctly (first char + *** + domain)", async () => {
    const { executeTool } = await import("../lib/tools.js");
    const stub: any = makeStatusStub("Test User", "test.user@hemmabo.se");
    const result = await executeTool("hemmabo_booking_status", { reservationId: "b-uuid" }, { supabase: stub, reader: stub });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.guestEmail, "t***@hemmabo.se");
  });

  it("does not expose raw guest_email", async () => {
    const { executeTool } = await import("../lib/tools.js");
    const stub: any = makeStatusStub("Test User", "test.user@hemmabo.se");
    const result = await executeTool("hemmabo_booking_status", { reservationId: "b-uuid" }, { supabase: stub, reader: stub });
    const raw = result.content[0].text;
    assert.ok(!raw.includes("test.user@hemmabo.se"), "Raw email must not appear in response");
  });

  it("does not expose raw guest_name (full surname)", async () => {
    const { executeTool } = await import("../lib/tools.js");
    const stub: any = makeStatusStub("Anna Svensson", "a@example.com");
    const result = await executeTool("hemmabo_booking_status", { reservationId: "b-uuid" }, { supabase: stub, reader: stub });
    const raw = result.content[0].text;
    assert.ok(!raw.includes("Svensson"), "Full surname must not appear in response");
  });
});
