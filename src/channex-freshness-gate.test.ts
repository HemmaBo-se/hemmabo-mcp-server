import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CALENDAR_FRESHNESS_MAX_MINUTES,
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
 *  - mapped node gates on the channel manager's sync state, fail-closed;
 *  - own 20-min window (pull cadence 15 min);
 *  - R5: the outward-shipped result never contains the vendor name;
 *  - the iCal import is retired (smart-stays ADR 2026-10-26-ical-retired,
 *    step 2c): the check never reads property_ical_imports.
 */

type ChannexState = { sync_status: string; last_synced_at: string | null } | null;

const tablesRead: string[] = [];

function fakeSupabase(opts: {
  channexPropertyId?: string | null;
  channexState?: ChannexState;
}) {
  const tables: Record<string, unknown> = {
    properties: { channex_property_id: opts.channexPropertyId ?? null },
    property_channex_sync_state: opts.channexState ?? null,
  };
  return {
    from: (table: string) => {
      tablesRead.push(table);
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

  it("FAIL-CLOSED: mapped node with no sync-state row blocks", async () => {
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

  it("reads no iCal table and reports the same max_age_minutes as before", async () => {
    tablesRead.length = 0;
    const result = await checkIcalImportFreshness(
      fakeSupabase({
        channexPropertyId: "cx-1",
        channexState: { sync_status: "success", last_synced_at: minutesBefore(45) },
      }), "prop-6", CHECKED_AT);
    assert.deepEqual(tablesRead, ["properties", "property_channex_sync_state"]);
    assert.equal(result.max_age_minutes, CALENDAR_FRESHNESS_MAX_MINUTES);
    assert.equal(CALENDAR_FRESHNESS_MAX_MINUTES, 10);
    assert.equal(result.safe, false);
    assert.deepEqual(result.checked_sources, [CHANNEL_MANAGER_SOURCE_LABEL]);
    assert.equal(result.active_import_count, 1);
    assert.deepEqual(result.stale_sources, [`${CHANNEL_MANAGER_SOURCE_LABEL}:45m_old`]);
  });
});
