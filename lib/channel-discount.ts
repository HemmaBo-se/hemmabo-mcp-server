/**
 * Channel discount — shared selection logic (mirrors smart-stays contracts/ts/channel-discount.ts).
 *
 * Acquisition discount per channel lives in `property_channel_discounts`.
 * Wallet loyalty discounts are separate and must never share this path.
 */

export type DiscountChannel = "website" | "agent";

export const DISCOUNT_CHANNELS: readonly DiscountChannel[] = ["website", "agent"];

/** Fallback when neither a channel row nor legacy value is present. */
export const DEFAULT_CHANNEL_DISCOUNT_PCT = 10;

/** DB CHECK headroom — dashboard offers 0..50. */
export const MAX_CHANNEL_DISCOUNT_PCT = 50;

export interface ChannelDiscountRow {
  channel: string;
  discount_pct: number | null;
}

export function isDiscountChannel(value: unknown): value is DiscountChannel {
  return value === "website" || value === "agent";
}

/** Clamp to [0, MAX]. Non-finite input → 0. */
export function clampDiscountPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(MAX_CHANNEL_DISCOUNT_PCT, Math.max(0, Math.round(pct)));
}

/**
 * Resolve acquisition discount (%) for a channel.
 *
 * Precedence:
 *   1. explicit `property_channel_discounts` row for the channel
 *   2. legacy `properties.direct_booking_discount`
 *   3. {@link DEFAULT_CHANNEL_DISCOUNT_PCT}
 */
export function pickChannelDiscountPct(
  rows: ChannelDiscountRow[] | null | undefined,
  channel: DiscountChannel,
  legacyPct?: number | null,
): number {
  const row = Array.isArray(rows)
    ? rows.find((r) => r?.channel === channel && typeof r.discount_pct === "number")
    : undefined;

  if (row && typeof row.discount_pct === "number") {
    return clampDiscountPct(row.discount_pct);
  }
  if (typeof legacyPct === "number") {
    return clampDiscountPct(legacyPct);
  }
  return DEFAULT_CHANNEL_DISCOUNT_PCT;
}
