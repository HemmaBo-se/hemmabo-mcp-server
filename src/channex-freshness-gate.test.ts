import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkIcalImportFreshness,
  CHANNEX_FRESHNESS_MAX_MINUTES,
  CHANNEL_MANAGER_SOURCE_LABEL,
} from "../lib/ical-freshness.js";

/**
 * Channex heartbeat in the calendar freshness gate — MCP mirror (PR-2b,
 * lockstep with smart-stays PR-2; ADR 2026-07-28 §5 / R1).
 *
 * Guards, mirrored from smart-stays test/channex-freshness-gate.test.ts:
 *  - unmapped node untouched (R6);
 *  - mapped node gates even with zero iCal feeds, fail-closed;
 *  - own 20-min window (pull cadence 15 min);
 *  - R5: the outward-shipped result never contains the vendor name;
 *  - checked_sources de-dup parity (the 2026-07-02 villaakerlyckan fix,
 *    which had drifted between the repos before this mirror).
 */

type ChannexState = { sync_status: string; last_synced_at: string | null } | null;
type IcalRow = {
  id: string; name: string | null; platform_source: string | null;
  sync_status: string | null; last_synced_at: string | null; error_message: string | null;
};

function fakeSupabase(opts: {
  icalRows?: IcalRow[];
  channexPropertyId?: string | null;
  channexState?: ChannexState;
}) {
  const tables: Record<string, unknown> = {
    property_ical_imports: opts.icalRows ?? [],
    properties: { channex_property_id: opts.channexPropertyId ?? null },
    property_channex_sync_state: opts.channexState ?? null,
  };
  return {
    from: (table: string) => {
      const data = tables[table];
      const result = Promise.resolve({ data, error: null });
      const builder = {
        select: () => builder,
        eq: () => Object.assign(result, {
          maybeSingle: () => Promise.resolve({ data, error: null }),
        }),
      };
      return builder;
    },
  } as never;
}

const CHECKED_AT = new Date("2026-07-29T12:00:00.000Z");
const minutesBefore = (m: number) => new Date(CHECKED_AT.getTime() - m * 60000).toISOString();

describe("channex heartbeat in checkIcalImportFreshness (MCP mirror)", () => {
  it("leaves an unmapped node untouched — zero imports stays safe (R6)", async () => {
    const result = await checkIcalImportFreshness(
      fakeSupabase({ channexPropertyId: null }), "prop-1", CHECKED_AT);
    assert.equal(result.safe, true);
    assert.ok(!result.checked_sources.includes(CHANNEL_MANAGER_SOURCE_LABEL));
  });

  it("FAIL-CLOSED: mapped node with no sync-state row blocks even with zero iCal feeds", async () => {
    const result = await checkIcalImportFreshness(
      fakeSupabase({ channexPropertyId: "cx-1", channexState: null }), "prop-2", CHECKED_AT);
    assert.equal(result.safe, false);
    assert.equal(result.reason, "calendar_sync_stale");
    assert.deepEqual(result.stale_sources, [`${CHANNEL_MANAGER_SOURCE_LABEL}:never_synced`]);
  });

  it("12-min-old success is safe under the 20-min channel-manager window", async () => {
    assert.equal(CHANNEX_FRESHNESS_MAX_MINUTES, 20);
    const result = await checkIcalImportFreshness(
      fakeSupabase({
        channexPropertyId: "cx-1",
        channexState: { sync_status: "success", last_synced_at: minutesBefore(12) },
      }), "prop-3", CHECKED_AT);
    assert.equal(result.safe, true);
    assert.deepEqual(result.checked_sources, [CHANNEL_MANAGER_SOURCE_LABEL]);
  });

  it("25-min-old success is stale; error status is unverified", async () => {
    const stale = await checkIcalImportFreshness(
      fakeSupabase({
        channexPropertyId: "cx-1",
        channexState: { sync_status: "success", last_synced_at: minutesBefore(25) },
      }), "prop-4", CHECKED_AT);
    assert.equal(stale.reason, "calendar_sync_stale");

    const errored = await checkIcalImportFreshness(
      fakeSupabase({
        channexPropertyId: "cx-1",
        channexState: { sync_status: "error", last_synced_at: null },
      }), "prop-5", CHECKED_AT);
    assert.equal(errored.reason, "calendar_sync_unverified");
  });

  it("R5: the outward-shipped result never contains the vendor name", async () => {
    const scenarios: ChannexState[] = [
      null,
      { sync_status: "success", last_synced_at: minutesBefore(2) },
      { sync_status: "error", last_synced_at: null },
    ];
    for (const channexState of scenarios) {
      const result = await checkIcalImportFreshness(
        fakeSupabase({ channexPropertyId: "cx-1", channexState }), "prop-r5", CHECKED_AT);
      assert.ok(!/channex/i.test(JSON.stringify(result)));
    }
  });

  it("PARITY (2026-07-02 fix): two same-platform calendars de-dupe checked_sources", async () => {
    const row = (id: string): IcalRow => ({
      id, name: "A", platform_source: "airbnb", sync_status: "success",
      last_synced_at: minutesBefore(2), error_message: null,
    });
    const result = await checkIcalImportFreshness(
      fakeSupabase({ icalRows: [row("a1"), row("a2")] }), "prop-6", CHECKED_AT);
    assert.deepEqual(result.checked_sources, ["airbnb"]);
    assert.equal(result.active_import_count, 2);
  });
});
