import type { SupabaseClient } from "@supabase/supabase-js";

export const CALENDAR_FRESHNESS_MAX_MINUTES = 10;

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

  if (activeImports.length === 0) {
    return {
      ...base,
      safe: true,
      reason: null,
    };
  }

  const staleSources: string[] = [];
  const errorSources: string[] = [];
  const checkedSources = activeImports.map(importLabel);
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

  const reason = errorSources.length > 0
    ? "calendar_sync_unverified"
    : staleSources.length > 0
      ? "calendar_sync_stale"
      : null;

  return {
    ...base,
    safe: reason === null,
    reason,
    active_import_count: activeImports.length,
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
