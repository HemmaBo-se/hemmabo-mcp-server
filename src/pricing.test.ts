/**
 * Pricing, availability, and tool-parity unit tests.
 *
 * Run: npx tsx --test src/pricing.test.ts
 *
 * These tests cover pure helpers exported from lib/pricing.ts,
 * mocked resolveQuote for package / gap rules, and tool parity
 * (both HemmaBo tools must be handled by executeTool).
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { isWeekend, daysBetween, findPriceBlock } from "../lib/pricing.js";
import type { PriceBlock } from "../lib/pricing.js";
import { pickChannelDiscountPct } from "../lib/channel-discount.js";
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

// ── Tool parity — both HemmaBo tools must be handled ──

describe("tool parity", () => {
  const EXPECTED_TOOLS = [
    "hemmabo_search_properties",
    "hemmabo_search_availability",
  ] as const;

  // We verify parity by calling executeTool with dummy args and checking
  // that the response is NOT the "Unknown tool" fallback. We use a stub
  // Supabase client that returns empty data to avoid real DB calls.
  it("both HemmaBo tools are handled by executeTool (not unknown)", async () => {
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
      // null data = no channex mapping → the freshness gate's channex path
      // stays inert (R6), matching a node that has never touched Channex.
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
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
        checkIn: "2025-07-01",
        checkOut: "2025-07-08",
        guests: 2,
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

describe("hemmabo_search_availability — capacity guard", () => {
  it("rejects guest counts above property max before suggesting date alternatives", async () => {
    const { executeTool } = await import("../lib/tools.js");

    const makeQuery = (table: string) => {
      const query: any = {
        select: () => query,
        eq: () => query,
        lt: () => query,
        gt: () => query,
        gte: () => query,
        or: () => query,
        neq: () => query,
        single: () => {
          if (table === "properties") {
            return Promise.resolve({
              data: { id: "villa", max_guests: 6 },
              error: null,
            });
          }
          return Promise.resolve({
            data: null,
            error: { message: "unexpected single" },
          });
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return query;
    };

    const stubSupabase: any = {
      from: (table: string) => makeQuery(table),
    };

    const result = await executeTool(
      "hemmabo_search_availability",
      {
        propertyId: "3ef1d46d-5c23-46fe-86cb-8e714abf734f",
        checkIn: "2026-05-23",
        checkOut: "2026-05-24",
        guests: 7,
      },
      { supabase: stubSupabase, reader: stubSupabase },
    );

    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.available, false);
    assert.equal(parsed.reasonCode, "guests_exceed_max");
    assert.equal(parsed.maxGuests, 6);
    assert.deepEqual(parsed.alternativeDates, []);
    assert.match(parsed.agentGuidance, /guest count exceeds/i);
  });
});

// ── channel discount source (property_channel_discounts) ─────────

describe("pickChannelDiscountPct", () => {
  it("prefers property_channel_discounts agent row over legacy column", () => {
    assert.equal(
      pickChannelDiscountPct(
        [
          { channel: "website", discount_pct: 10 },
          { channel: "agent", discount_pct: 5 },
        ],
        "agent",
        15,
      ),
      5,
    );
  });

  it("falls back to legacy direct_booking_discount when no row", () => {
    assert.equal(pickChannelDiscountPct([], "agent", 15), 15);
  });

  it("defaults to 10% when neither row nor legacy is present", () => {
    assert.equal(pickChannelDiscountPct(null, "agent", null), 10);
  });
});

describe("resolveQuote — host direct price folded into one total", () => {
  // Builds a stub property with a given agent acquisition discount.
  const makeStub = (opts: { channelRows: any[]; legacyDiscount: number | null; stayRules?: any[]; gapEnabled?: boolean; gapPct?: number | null; hasNeighbors?: boolean }) => ({
    from: (table: string) => {
      const season = {
        name: "low",
        date_from: "2026-09-01",
        date_to: "2026-09-30",
        type: "low" as const,
      };
      const block = {
        guests: 6,
        low_weekday: 1000,
        low_weekend: 1200,
        high_weekday: 1500,
        high_weekend: 1800,
        low_week: null,
        high_week: null,
        low_two_weeks: null,
        high_two_weeks: null,
      };
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        gte: () => chain,
        lte: () => chain,
        limit: () => chain,
        single: () => {
          if (table === "properties") {
            return Promise.resolve({
              data: {
                id: "00000000-0000-0000-0000-000000000099",
                name: "Test Villa",
                currency: "SEK",
                max_guests: 8,
                direct_booking_discount: opts.legacyDiscount,
                min_nights: 1,
                max_nights: 30,
                published: true,
              },
              error: null,
            });
          }
          if (table === "property_smart_pricing") {
            return Promise.resolve({
              data: {
                gap_fill_enabled: opts.gapEnabled ?? false,
                gap_fill_min_nights: 2,
                gap_night_discount_pct: opts.gapPct ?? null,
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (table === "property_price_blocks") {
            return Promise.resolve({ data: [block], error: null }).then(resolve);
          }
          if (table === "property_seasons") {
            return Promise.resolve({ data: [season], error: null }).then(resolve);
          }
          if (table === "property_channel_discounts") {
            return Promise.resolve({ data: opts.channelRows, error: null }).then(resolve);
          }
          if (table === "property_stay_discounts") {
            return Promise.resolve({ data: opts.stayRules ?? [], error: null }).then(resolve);
          }
          if (table === "bookings") {
            return Promise.resolve({
              data: opts.hasNeighbors ? [{ id: "neighbor" }] : [],
              error: null,
            }).then(resolve);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return chain;
    },
  });

  it("folds the agent lever into ONE total — public === federation, no spread", async () => {
    const { resolveQuote } = await import("../lib/pricing.js");
    const stub: any = makeStub({
      channelRows: [
        { channel: "agent", discount_pct: 5 },
        { channel: "website", discount_pct: 5 },
      ],
      legacyDiscount: 15,
    });

    // Rack = 1000 (Wed) + 1000 (Thu) + 1200 (Fri) = 3200; agent lever 5% → round(3200 × 0.95) = 3040.
    const quote = await resolveQuote(stub, "00000000-0000-0000-0000-000000000099", "2026-09-02", "2026-09-05", 4);
    assert.ok(!("error" in quote));
    if ("error" in quote) return;

    assert.equal(quote.publicTotal, 3040);
    assert.equal(quote.federationTotal, quote.publicTotal); // one number — no spread
    assert.equal(quote.federationDiscountPercent, 0);

    // Folded nightly rates self-reconcile to the total (empty-adjustments invariant).
    const nightlySum = quote.breakdown.nightlyRates.reduce((s, n) => s + n.rate, 0);
    assert.equal(nightlySum, quote.federationTotal);
  });

  it("is a no-op when the host has set no acquisition discount (rack unchanged)", async () => {
    const { resolveQuote } = await import("../lib/pricing.js");
    const stub: any = makeStub({ channelRows: [], legacyDiscount: 0 });

    const quote = await resolveQuote(stub, "00000000-0000-0000-0000-000000000099", "2026-09-02", "2026-09-05", 4);
    assert.ok(!("error" in quote));
    if ("error" in quote) return;

    assert.equal(quote.publicTotal, 3200); // 0% lever → rack stands
    assert.equal(quote.federationTotal, 3200);
    assert.equal(quote.federationDiscountPercent, 0);
    const nightlySum = quote.breakdown.nightlyRates.reduce((s, n) => s + n.rate, 0);
    assert.equal(nightlySum, 3200);
  });

  it("slider model (ADR 2026-08-13 D3): stay rules reprice the stay and suppress gap", async () => {
    const { resolveQuote } = await import("../lib/pricing.js");
    // 3 nights Wed–Sat: 1000 + 1000 + 1200 = 3200 rack sum. One stay_length
    // rule at 2+ nights, 10 % → round(3200 × 0.90) = 2880. The same rule
    // must SUPPRESS the gap discount (D1: discounts never stack) — the stub
    // has gap disabled, so the suppression is pinned via gapNight === false
    // and the total standing at the stay-priced 2880.
    const stub: any = makeStub({
      channelRows: [],
      legacyDiscount: 0,
      stayRules: [{ kind: "stay_length", threshold_units: 2, pct: 10 }],
    });

    const quote = await resolveQuote(stub, "00000000-0000-0000-0000-000000000099", "2026-09-02", "2026-09-05", 4);
    assert.ok(!("error" in quote));
    if ("error" in quote) return;

    assert.equal(quote.publicTotal, 2880); // ONE winning rule on the nightly sum
    assert.equal(quote.federationTotal, 2880);
    assert.equal(quote.packageApplied, null); // packages retired in slider mode
    assert.equal(quote.gapNight, false); // never stacked with gap
  });

  it("control: with gap ACTIVE and no stay rules, the gap discount fires (proves the stub bites)", async () => {
    const { resolveQuote } = await import("../lib/pricing.js");
    const stub: any = makeStub({
      channelRows: [],
      legacyDiscount: 0,
      gapEnabled: true,
      gapPct: 10,
      hasNeighbors: true,
    });

    const quote = await resolveQuote(stub, "00000000-0000-0000-0000-000000000099", "2026-09-02", "2026-09-05", 4);
    assert.ok(!("error" in quote));
    if ("error" in quote) return;

    assert.equal(quote.gapNight, true); // 3 nights <= minNights+1, neighbors both sides
    assert.equal(quote.gapTotal, 2880); // round(3200 × 0.90)
  });

  it("D1 hard pin: an ACTIVE gap is suppressed by a kernel-applied stay rule — never stacked", async () => {
    const { resolveQuote } = await import("../lib/pricing.js");
    // Identical gap-active stub as the control — plus one stay rule. The stay
    // rule wins, the gap decision is suppressed outright (no 10% on 10%).
    const stub: any = makeStub({
      channelRows: [],
      legacyDiscount: 0,
      gapEnabled: true,
      gapPct: 10,
      hasNeighbors: true,
      stayRules: [{ kind: "stay_length", threshold_units: 2, pct: 10 }],
    });

    const quote = await resolveQuote(stub, "00000000-0000-0000-0000-000000000099", "2026-09-02", "2026-09-05", 4);
    assert.ok(!("error" in quote));
    if ("error" in quote) return;

    assert.equal(quote.publicTotal, 2880); // the stay rule priced the stay…
    assert.equal(quote.gapNight, false); // …and the active gap yielded (D1)
    assert.equal(quote.gapTotal, null); // no second discount exists at all
  });
});
