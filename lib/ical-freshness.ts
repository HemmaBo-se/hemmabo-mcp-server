import type { SupabaseClient } from "@supabase/supabase-js";

export const CALENDAR_FRESHNESS_MAX_MINUTES = 10;

/**
 * Channex has its own freshness window: the pull reconcile runs every 15
 * minutes (Channex best-practice floor; webhooks only accelerate), so the
 * iCal 10-minute window would mark a healthy Channex node stale between
 * pulls. 20 = cadence + margin.
 */
export const CHANNEX_FRESHNESS_MAX_MINUTES = 20;

/**
 * Outward label for the Channex source in checked_sources/stale_sources/
 * error_sources. The freshness result ships inside tool responses and
 * signed offers (agent-facing, machine-readable), and R5 forbids any
 * vendor mention there — the label is therefore neutral. Internal
 * tables/columns keep the vendor name; they never leave the server.
 *
 * Mirror of smart-stays api/_lib/ical-freshness.ts (PR-2 / PR-2b lockstep,
 * 2026-07-29) — keep the two files in parity apart from the
 * calendarFreshnessUnavailablePayload export below, which is MCP-only.
 * This mirror also brings over the checked_sources de-dup fix
 * (villaakerlyckan 2026-07-02: two Airbnb listings must not ship
 * ["airbnb","airbnb"]), which had drifted between the repos.
 */
export const CHANNEL_MANAGER_SOURCE_LABEL = "channel_manager";

export type IcalImportRow = {
  id: string;
  name: string | null;
  platform_source: string | null;
  sync_status: string | null;
  last_synced_at: string | null;
  error_message: string | null;
};

export type CalendarFreshnessResult = {
  safe: boolean;
  reason: string | null;
  checked_at: string;
  max_age_minutes: number;
  active_import_count: number;
  checked_sources: string[];
  stale_sources: string[];
  error_sources: string[];
  latest_synced_at: string | null;
};

function importLabel(row: IcalImportRow) {
  return row.platform_source || row.name || row.id || "ical_import";
}

export async function checkIcalImportFreshness(
  supabase: SupabaseClient,
  propertyId: string,
  checkedAt: Date,
): Promise<CalendarFreshnessResult> {
  const checkedAtIso = checkedAt.toISOString();
  const base = {
    checked_at: checkedAtIso,
    max_age_minutes: CALENDAR_FRESHNESS_MAX_MINUTES,
    active_import_count: 0,
    checked_sources: [] as string[],
    stale_sources: [] as string[],
    error_sources: [] as string[],
    latest_synced_at: null as string | null,
  };

  const { data, error } = await supabase
    .from("property_ical_imports")
    .select("id,name,platform_source,sync_status,last_synced_at,error_message")
    .eq("property_id", propertyId);

  if (error) {
    return {
      ...base,
      safe: false,
      reason: "calendar_sync_unverified",
      error_sources: ["property_ical_imports_query_failed"],
    };
  }

  const activeImports = ((data || []) as IcalImportRow[]).filter(
    (row) => row.sync_status !== "disabled",
  );

  const staleSources: string[] = [];
  const errorSources: string[] = [];
  // Distinct source PLATFORMS we checked freshness against. A host can run more
  // than one calendar on the same platform (villaakerlyckan.se has two separate
  // Airbnb listings + one Booking.com) — every calendar is counted in
  // `active_import_count`, but `checked_sources` reports the platform SET, so it
  // must not repeat "airbnb". De-dupe while preserving first-seen order.
  const checkedSources = [...new Set(activeImports.map(importLabel))];
  let activeImportCount = activeImports.length;
  let latestSyncedAt: string | null = null;

  for (const row of activeImports) {
    const label = importLabel(row);
    if (row.last_synced_at && (!latestSyncedAt || row.last_synced_at > latestSyncedAt)) {
      latestSyncedAt = row.last_synced_at;
    }

    if (row.sync_status && row.sync_status !== "success") {
      errorSources.push(`${label}:${row.sync_status}`);
      continue;
    }

    if (!row.last_synced_at) {
      staleSources.push(`${label}:never_synced`);
      continue;
    }

    const ageMs = checkedAt.getTime() - new Date(row.last_synced_at).getTime();
    const ageMinutes = ageMs / 60000;
    if (!Number.isFinite(ageMinutes) || ageMinutes > CALENDAR_FRESHNESS_MAX_MINUTES) {
      staleSources.push(`${label}:${Math.round(ageMinutes)}m_old`);
    }
  }

  // ── Channex heartbeat (PR-2b, 2026-07-29) ────────────────────────────────
  // A node mapped to a Channex property (properties.channex_property_id set)
  // gates on property_channex_sync_state exactly like iCal feeds gate on
  // property_ical_imports — including when the node has ZERO iCal feeds, so
  // this runs before any "no active imports" shortcut. Unmapped nodes are
  // untouched (per-node isolation, R6). Fail-closed throughout: an
  // unanswerable question about calendar truth blocks agent booking (R1).
  const { data: propertyRow, error: propertyError } = await supabase
    .from("properties")
    .select("channex_property_id")
    .eq("id", propertyId)
    .maybeSingle();

  if (propertyError) {
    errorSources.push(`${CHANNEL_MANAGER_SOURCE_LABEL}:mapping_query_failed`);
  } else if (propertyRow?.channex_property_id) {
    const { data: stateRow, error: stateError } = await supabase
      .from("property_channex_sync_state")
      .select("sync_status,last_synced_at")
      .eq("property_id", propertyId)
      .maybeSingle();

    if (stateError) {
      errorSources.push(`${CHANNEL_MANAGER_SOURCE_LABEL}:state_query_failed`);
    } else if (stateRow?.sync_status === "disabled") {
      // Host paused the Channex path for this node — not an active source.
    } else {
      activeImportCount += 1;
      checkedSources.push(CHANNEL_MANAGER_SOURCE_LABEL);

      const status = stateRow?.sync_status ?? null;
      const syncedAt = stateRow?.last_synced_at ?? null;
      if (syncedAt && (!latestSyncedAt || syncedAt > latestSyncedAt)) {
        latestSyncedAt = syncedAt;
      }

      if (!stateRow) {
        // Mapped but never synced (no state row yet) — connected ≠ verified.
        staleSources.push(`${CHANNEL_MANAGER_SOURCE_LABEL}:never_synced`);
      } else if (status && status !== "success") {
        errorSources.push(`${CHANNEL_MANAGER_SOURCE_LABEL}:${status}`);
      } else if (!syncedAt) {
        staleSources.push(`${CHANNEL_MANAGER_SOURCE_LABEL}:never_synced`);
      } else {
        const ageMinutes = (checkedAt.getTime() - new Date(syncedAt).getTime()) / 60000;
        if (!Number.isFinite(ageMinutes) || ageMinutes > CHANNEX_FRESHNESS_MAX_MINUTES) {
          staleSources.push(`${CHANNEL_MANAGER_SOURCE_LABEL}:${Math.round(ageMinutes)}m_old`);
        }
      }
    }
  }

  if (activeImportCount === 0 && errorSources.length === 0) {
    return {
      ...base,
      safe: true,
      reason: null,
    };
  }

  const reason = errorSources.length > 0
    ? "calendar_sync_unverified"
    : staleSources.length > 0
      ? "calendar_sync_stale"
      : null;

  return {
    ...base,
    safe: reason === null,
    reason,
    active_import_count: activeImportCount,
    checked_sources: checkedSources,
    stale_sources: staleSources,
    error_sources: errorSources,
    latest_synced_at: latestSyncedAt,
  };
}

export function calendarFreshnessUnavailablePayload(
  propertyId: string,
  checkIn: string,
  checkOut: string,
  calendarFreshness: CalendarFreshnessResult,
) {
  const reasonCode = calendarFreshness.reason === "calendar_sync_unverified"
    ? "calendar_sync_unverified"
    : "calendar_sync_stale";

  return {
    propertyId,
    checkIn,
    checkOut,
    available: false,
    reasonCode,
    reason: reasonCode === "calendar_sync_unverified"
      ? "Incoming OTA calendar sync could not be verified."
      : "Incoming OTA calendar sync is stale.",
    calendar_freshness: calendarFreshness,
    agentGuidance:
      "Do not quote bookability. Call get_verified_stay_offer on the host domain after calendar sync is fresh.",
  };
}
