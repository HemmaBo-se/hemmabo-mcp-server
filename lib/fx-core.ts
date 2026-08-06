/**
 * fx-core — canonical currency conversion (Layer 3, runtime-agnostic, PURE).
 *
 * Decided by ADR `docs/DECISIONS/2026-08-06-fx-core-node-currency-base.md`
 * with siblings `2026-08-06-currency-display-translation-approx.md` and
 * `2026-08-06-channex-fx-settlement-host-margin.md`.
 *
 * Canonical rules encoded here:
 *   - Base = the NODE currency (the host's explicit dashboard choice,
 *     `properties.currency`) — never a hardcoded pivot. SEK is just one
 *     possible base among the supported set.
 *   - Source: ECB reference rates (served via the Frankfurter API). HemmaBo
 *     never adjusts, spreads or margins the rate itself — the only margin in
 *     the system is the HOST's settlement safety margin, applied here as a
 *     transparent input and owned by the host (no gatekeeper).
 *   - Two grades, one module:
 *       display    — cached rates acceptable, static fallback acceptable;
 *                    the UI must always mark the result ≈ with the original
 *                    amount visible (never an exact foreign figure).
 *       settlement — the number becomes a real OTA price. Requires a FRESH
 *                    live ECB rate (`SETTLEMENT_MAX_AGE_MS`); static
 *                    fallback is FORBIDDEN. No fresh rate ⇒ the caller must
 *                    refuse (fail-closed, same discipline as the #2513 ARI
 *                    currency guard).
 *   - Snapshot discipline: settlement conversions carry a full snapshot
 *     (base, quote, rate, source, fetchedAt) so every pushed figure can be
 *     explained afterwards.
 *
 * This module is transport-agnostic on purpose: fetching happens in the
 * runtime adapters (`api/forex-rates.ts`, edge functions); formatting
 * happens in the UI layers. Pure decision + math only, so the decision
 * table is unit-testable like the module's Layer-3 siblings.
 */

export type FxGrade = "display" | "settlement";
export type FxSource = "ecb-frankfurter" | "static-fallback";

export interface FxSnapshot {
  /** ISO-4217 code of the NODE currency (conversion base). */
  base: string;
  /** ISO-4217 code of the target currency. */
  quote: string;
  /** 1 unit of `base` = `rate` units of `quote`. */
  rate: number;
  source: FxSource;
  /** ISO-8601 instant when the rate was obtained from the source. */
  fetchedAt: string;
}

/**
 * Node currencies the dashboard picker offers (2-decimal ISO-4217 only,
 * PR #2514 — the ARI projection and Stripe minor-unit math assume ×100).
 * Every entry is an ECB reference currency served by Frankfurter, so any
 * of them can be a conversion base.
 */
export const SUPPORTED_NODE_CURRENCIES = [
  "SEK", "NOK", "DKK", "EUR", "GBP", "USD",
  "CHF", "PLN", "CZK", "CAD", "AUD", "NZD",
] as const;

/**
 * Display-only quote currencies we additionally translate into (superset of
 * the node set; HUF has 2 decimals but is not offered as a node currency).
 */
export const DISPLAY_QUOTE_CURRENCIES = [
  ...SUPPORTED_NODE_CURRENCIES, "HUF",
] as const;

/**
 * Maximum age of a settlement-grade rate, measured from OUR fetch of the
 * live source (not ECB's publish time — Frankfurter always serves the
 * latest ECB reference, including over weekends). 24 h: strictly fresher
 * than the ARI sweep cadence, generous against transient API blips. Older
 * than this ⇒ not settlement grade ⇒ the push must refuse.
 */
export const SETTLEMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Host safety-margin bounds (percent). The margin is the host's knob —
 * HemmaBo never adds its own. Upper bound guards against typos (390 € with
 * 200 % margin), not against host intent. */
export const HOST_MARGIN_MIN_PCT = 0;
export const HOST_MARGIN_MAX_PCT = 20;

export function isValidIso4217(code: unknown): code is string {
  return typeof code === "string" && /^[A-Z]{3}$/.test(code);
}

export function isSupportedNodeCurrency(code: string): boolean {
  return (SUPPORTED_NODE_CURRENCIES as readonly string[]).includes(code);
}

/** Frankfurter URL for one base against a quote list (base excluded). */
export function buildFrankfurterUrl(base: string, quotes: readonly string[]): string {
  if (!isValidIso4217(base)) {
    throw new Error(`fx-core: invalid base currency ${JSON.stringify(base)}`);
  }
  const to = quotes.filter((q) => isValidIso4217(q) && q !== base);
  if (to.length === 0) {
    throw new Error("fx-core: no valid quote currencies");
  }
  return `https://api.frankfurter.app/latest?from=${base}&to=${to.join(",")}`;
}

// `error?: undefined` on the ok-variant keeps `.error` accessible on the
// union without narrowing — the api layer type-checks under a non-strict
// tsconfig where discriminant narrowing is unavailable.
export type FxVerdict =
  | { ok: true; error?: undefined }
  | { ok: false; error: string };

/** Structural validity of a snapshot (both grades). */
export function validateSnapshot(s: FxSnapshot): FxVerdict {
  if (!isValidIso4217(s.base)) {
    return { ok: false, error: `invalid base currency ${JSON.stringify(s.base)}` };
  }
  if (!isValidIso4217(s.quote)) {
    return { ok: false, error: `invalid quote currency ${JSON.stringify(s.quote)}` };
  }
  if (!Number.isFinite(s.rate) || s.rate <= 0) {
    return { ok: false, error: `invalid rate ${String(s.rate)} for ${s.base}->${s.quote}` };
  }
  if (s.base === s.quote && s.rate !== 1) {
    return { ok: false, error: `identity pair ${s.base}->${s.quote} must have rate 1` };
  }
  if (Number.isNaN(Date.parse(s.fetchedAt))) {
    return { ok: false, error: `invalid fetchedAt ${JSON.stringify(s.fetchedAt)}` };
  }
  return { ok: true };
}

/**
 * Settlement gate: is this snapshot allowed to price a real OTA push?
 * Fail-closed — anything not provably fresh-live is refused.
 */
export function assessSettlementGrade(s: FxSnapshot, nowMs: number): FxVerdict {
  const structural = validateSnapshot(s);
  if (!structural.ok) return structural;
  if (s.source !== "ecb-frankfurter") {
    return {
      ok: false,
      error:
        `source ${JSON.stringify(s.source)} is not settlement grade — ` +
        "static fallback rates are display-only (ADR 2026-08-06 fx-core)",
    };
  }
  const age = nowMs - Date.parse(s.fetchedAt);
  if (age < 0) {
    return { ok: false, error: `fetchedAt ${s.fetchedAt} is in the future` };
  }
  if (age > SETTLEMENT_MAX_AGE_MS) {
    return {
      ok: false,
      error:
        `rate for ${s.base}->${s.quote} is ${Math.round(age / 3_600_000)}h old ` +
        `(max ${SETTLEMENT_MAX_AGE_MS / 3_600_000}h) — refusing settlement conversion`,
    };
  }
  return { ok: true };
}

/** Pure conversion. Throws on non-finite input — callers validate amounts. */
export function convertAmount(amount: number, s: FxSnapshot): number {
  if (!Number.isFinite(amount)) {
    throw new Error(`fx-core: non-finite amount ${String(amount)}`);
  }
  const structural = validateSnapshot(s);
  if (!structural.ok) throw new Error(`fx-core: ${structural.error}`);
  return amount * s.rate;
}

/**
 * Display conversion: whole quote units, round half-up. The UI layer OWNS
 * the ≈ presentation (translated figure marked approximate, original always
 * visible) — this function only produces the number.
 */
export function convertForDisplay(amount: number, s: FxSnapshot): number {
  return Math.round(convertAmount(amount, s));
}

export type SettlementConversion =
  | { ok: true; amount: number; marginPct: number; snapshot: FxSnapshot }
  | { ok: false; error: string };

/**
 * Settlement conversion: `amount × rate × (1 + hostMarginPct/100)`, rounded
 * to 2 decimals (the supported node set is 2-decimal ISO-4217 only). The
 * margin belongs to the HOST — the host bears the FX drift between push and
 * booking, never HemmaBo (CEO decision 2026-08-06, no gatekeeper). Refuses
 * unless the snapshot is settlement grade.
 */
export function convertForSettlement(
  amount: number,
  s: FxSnapshot,
  hostMarginPct: number,
  nowMs: number,
): SettlementConversion {
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: `invalid amount ${String(amount)}` };
  }
  if (
    !Number.isFinite(hostMarginPct) ||
    hostMarginPct < HOST_MARGIN_MIN_PCT ||
    hostMarginPct > HOST_MARGIN_MAX_PCT
  ) {
    return {
      ok: false,
      error:
        `host margin ${String(hostMarginPct)} is outside ` +
        `[${HOST_MARGIN_MIN_PCT}, ${HOST_MARGIN_MAX_PCT}] percent`,
    };
  }
  const grade = assessSettlementGrade(s, nowMs);
  if (!grade.ok) return { ok: false, error: grade.error ?? "not settlement grade" };
  const raw = amount * s.rate * (1 + hostMarginPct / 100);
  const rounded = Math.round(raw * 100) / 100;
  return { ok: true, amount: rounded, marginPct: hostMarginPct, snapshot: s };
}
