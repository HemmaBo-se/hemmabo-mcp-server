/**
 * Price reconciliation — shared core (Layer 3, runtime-agnostic).
 *
 * The signed verified-stay-offer must SELF-RECONCILE: the line items a guest
 * sees (the nightly `breakdown` plus neutral channel/package adjustment lines)
 * must add up to the total the agent quotes. This module is the single, pure
 * source for that arithmetic so the offer builder (api/verified-stay-offer.ts)
 * can assert reconciliation BEFORE signing and never sign a contradictory
 * "exact" offer.
 *
 * Same `contracts/ts/**` shared-core pattern as `channel-discount.ts` /
 * `availability-core.ts` (covered by `vercel.json` includeFiles).
 *
 * Vocabulary lock (work order §2 + docs/CANONICAL_PRICE_CONTRACT.md):
 *  - Adjustment lines are NEUTRAL, informative lines. The machine `code` may
 *    stay `agent_channel_rate`; the human/agent-facing `label` is NEVER
 *    "discount", "rabatt", "savings", "besparing", "promo", or any OTA /
 *    marketplace comparison.
 *  - `public_total` and `agent_total` both stay in the signed payload.
 *  - `total` (P5) = the channel-resolved total the agent quotes = `agent_total`
 *    when an agent rate applies, otherwise `public_total`.
 */

/** One signed line that turns the rack `breakdown` into the quoted total. */
export interface PriceAdjustment {
  /** Machine code (stable, not shown verbatim to guests). */
  code: string;
  /** Human/agent-facing NEUTRAL label, localised per offer language. */
  label: string;
  /** Signed minor-unit delta (negative = lower than the rack subtotal). */
  amount: number;
  /** Whether the amount applies once per stay or per night. */
  scope: "stay" | "night";
}

/** Machine-checkable reconciliation block (for verifiers, not the visible UI). */
export interface PriceReconciliation {
  nightly_subtotal: number;
  adjustments_total: number;
  computed_total: number;
  matches_quoted_total: boolean;
}

/** A minimal breakdown row — only the field reconciliation depends on. */
export interface ReconcilableNight {
  nightly_rate?: number | null;
}

/**
 * Neutral, localised label for the agent-channel rate line. NEVER a discount /
 * savings / OTA-comparison word — that would contradict
 * `agent_guardrails.must_not_present_discounts_or_savings`.
 */
export const AGENT_CHANNEL_RATE_LABEL: Record<string, string> = {
  sv: "Agentkanal-pris",
  en: "Agent channel rate",
  de: "Agentkanal-Preis",
  fr: "Tarif canal agent",
  it: "Tariffa canale agente",
  es: "Tarifa de canal de agente",
  nl: "Agentkanaal-tarief",
  da: "Agentkanal-pris",
  no: "Agentkanal-pris",
  fi: "Agenttikanavan hinta",
  pl: "Cena kanału agenta",
  ar: "سعر قناة الوكيل",
};

/** Neutral, localised label for the week/two-week package-rate line. */
export const PACKAGE_RATE_LABEL: Record<string, string> = {
  sv: "Paketpris",
  en: "Package rate",
  de: "Paketpreis",
  fr: "Tarif forfait",
  it: "Tariffa pacchetto",
  es: "Tarifa de paquete",
  nl: "Pakkettarief",
  da: "Pakkepris",
  no: "Pakkepris",
  fi: "Pakettihinta",
  pl: "Cena pakietu",
  ar: "سعر الباقة",
};

/**
 * NEUTRAL label per the offer schema's adjustment rule ("Never a
 * discount/savings/OTA-comparison label") — the slider model's stay-length
 * price is a RATE line exactly like the package rate, never a "discount".
 */
export const STAY_RATE_LABEL: Record<string, string> = {
  sv: "Vistelsepris",
  en: "Stay rate",
  de: "Aufenthaltspreis",
  fr: "Tarif séjour",
  it: "Tariffa soggiorno",
  es: "Tarifa de estancia",
  nl: "Verblijfstarief",
  da: "Opholdspris",
  no: "Oppholdspris",
  fi: "Oleskeluhinta",
  pl: "Cena pobytu",
  ar: "سعر الإقامة",
};

/**
 * NEUTRAL label for the gap-night rate line — the calendar-gap price the host
 * configured (`property_smart_pricing.gap_night_discount_pct`), surfaced as a
 * RATE line exactly like package/stay rates. Never a "discount"/"savings"
 * word, per the offer schema's adjustment rule.
 */
export const GAP_NIGHT_RATE_LABEL: Record<string, string> = {
  sv: "Lucknattspris",
  en: "Gap night rate",
  de: "Lückennacht-Preis",
  fr: "Tarif nuit intercalaire",
  it: "Tariffa notte intermedia",
  es: "Tarifa de noche intermedia",
  nl: "Tussenliggende-nacht-tarief",
  da: "Mellemnatspris",
  no: "Mellomnattspris",
  fi: "Välipäivähinta",
  pl: "Cena nocy pośredniej",
  ar: "سعر الليلة البينية",
};

/** Pick a localised label, falling back to English then the first key. */
function pickLabel(map: Record<string, string>, language: string | null | undefined): string {
  const lang = (language || "").toLowerCase().slice(0, 2);
  return map[lang] || map.en;
}

/** Σ of the nightly `breakdown` rates (the rack subtotal). */
export function sumNightly(breakdown: ReconcilableNight[] | null | undefined): number {
  if (!Array.isArray(breakdown)) return 0;
  return breakdown.reduce((sum, n) => {
    const rate = Number(n?.nightly_rate);
    return sum + (Number.isFinite(rate) ? rate : 0);
  }, 0);
}

/** Σ of the adjustment amounts. */
export function sumAdjustments(adjustments: PriceAdjustment[] | null | undefined): number {
  if (!Array.isArray(adjustments)) return 0;
  return adjustments.reduce((sum, a) => {
    const amount = Number(a?.amount);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
}

/**
 * Recompute reconciliation from the very fields that will be SIGNED.
 *
 * A verifier does exactly this: `Σ breakdown.nightly_rate + Σ adjustments.amount`
 * must equal the quoted `total`. Returns `matches_quoted_total: false` when they
 * disagree — the builder turns that into a blocked signing / `exact:false`.
 */
export function reconcile(
  breakdown: ReconcilableNight[] | null | undefined,
  adjustments: PriceAdjustment[] | null | undefined,
  quotedTotal: number,
): PriceReconciliation {
  const nightlySubtotal = sumNightly(breakdown);
  const adjustmentsTotal = sumAdjustments(adjustments);
  const computedTotal = nightlySubtotal + adjustmentsTotal;
  return {
    nightly_subtotal: nightlySubtotal,
    adjustments_total: adjustmentsTotal,
    computed_total: computedTotal,
    matches_quoted_total: computedTotal === quotedTotal,
  };
}

export interface AdjustmentInputs {
  /** Σ of the rack nightly rates (must equal sumNightly(breakdown)). */
  nightlySubtotal: number;
  /** Website/rack total — what the site charges (reconciles to `breakdown`). */
  publicTotal: number;
  /** Host's signed direct price for the agent channel. */
  agentTotal: number;
  /** "week" | "two_weeks" | null — emits a neutral package-rate line when set. */
  packageApplied?: string | null;
  /**
   * The kernel's winning stay-discount decision (slider model, ADR
   * 2026-08-13 D3) — emits a neutral stay-discount line when set. The
   * kernel guarantees packageApplied and stayDiscountApplied are never
   * both set (stay mode skips the package branch entirely).
   */
  stayDiscountApplied?: { pct: number; kind: string; thresholdUnits: number } | null;
  /** Offer language for the neutral labels. */
  language?: string | null;
}

/**
 * Build the neutral adjustment lines that turn the rack `breakdown` into the
 * agent-channel `agent_total`:
 *
 *   1. `package_rate`        — only when a week/two-week package price differs
 *                              from the rack nightly subtotal.
 *   2. `agent_channel_rate`  — only when the agent total differs from the
 *                              public total.
 *
 * By construction `nightlySubtotal + Σ amounts === agentTotal`, so the offer
 * self-reconciles for night-by-night AND package stays. Each line is emitted
 * only when its amount is non-zero, so the public-channel view (rack
 * night-by-night) carries no adjustments at all.
 */
export function buildAgentChannelAdjustments(inputs: AdjustmentInputs): PriceAdjustment[] {
  const { nightlySubtotal, publicTotal, agentTotal, packageApplied, stayDiscountApplied, language } =
    inputs;
  const adjustments: PriceAdjustment[] = [];

  const packageDelta = publicTotal - nightlySubtotal;
  if (packageApplied && packageDelta !== 0) {
    adjustments.push({
      code: "package_rate",
      label: pickLabel(PACKAGE_RATE_LABEL, language),
      amount: packageDelta,
      scope: "stay",
    });
  } else if (stayDiscountApplied && packageDelta !== 0) {
    // Same structural bridge as package_rate: the rack total departed from
    // the nightly subtotal by the ONE winning stay-discount rule, and the
    // line makes the offer self-reconcile night-by-night (P2 exactness).
    // Neutral RATE code+label per the schema's adjustment rule.
    adjustments.push({
      code: "stay_rate",
      label: pickLabel(STAY_RATE_LABEL, language),
      amount: packageDelta,
      scope: "stay",
    });
  }

  const agentDelta = agentTotal - publicTotal;
  if (agentDelta !== 0) {
    adjustments.push({
      code: "agent_channel_rate",
      label: pickLabel(AGENT_CHANNEL_RATE_LABEL, language),
      amount: agentDelta,
      scope: "stay",
    });
  }

  return adjustments;
}

export interface ReconciledPrice {
  /** P5: channel-resolved total the agent quotes. */
  total: number | null;
  adjustments: PriceAdjustment[];
  reconciliation: PriceReconciliation | null;
  /** P2: true ONLY when the offer reconciles and nothing is estimated. */
  exact: boolean;
}

/**
 * One-call builder used by the offer assembler. Returns the channel-resolved
 * `total`, the neutral `adjustments`, the signed `reconciliation` block, and an
 * honest `exact` flag.
 *
 * `priced` is the upstream "did we resolve a real quote?" flag (false ⇒ not
 * bookable / no price ⇒ `exact:false`, empty adjustments, null reconciliation).
 * When `priced` is true the breakdown/public/agent totals must all be present;
 * if they are not, the price is treated as non-exact rather than invented.
 */
export function buildReconciledPrice(args: {
  priced: boolean;
  breakdown: ReconcilableNight[] | null | undefined;
  publicTotal: number | null;
  agentTotal: number | null;
  packageApplied?: string | null;
  stayDiscountApplied?: { pct: number; kind: string; thresholdUnits: number } | null;
  language?: string | null;
  /**
   * The gap-night-adjusted final total (chain position: rack → stay/package →
   * channel fold → gap, D1). When present and different from `agentTotal`, the
   * quoted total becomes this value and the delta surfaces as ONE neutral
   * `gap_night_rate` line — so a quote door that applies the gap discount
   * still self-reconciles: Σ breakdown + Σ adjustments === total. Omit (or
   * pass null/undefined) for the pre-existing no-gap behavior, byte-identical.
   */
  gapAdjustedTotal?: number | null;
}): ReconciledPrice {
  const {
    priced,
    breakdown,
    publicTotal,
    agentTotal,
    packageApplied,
    stayDiscountApplied,
    language,
    gapAdjustedTotal,
  } = args;

  if (
    !priced ||
    publicTotal === null ||
    agentTotal === null ||
    !Array.isArray(breakdown)
  ) {
    return {
      total: gapAdjustedTotal ?? agentTotal ?? publicTotal ?? null,
      adjustments: [],
      reconciliation: null,
      exact: false,
    };
  }

  const nightlySubtotal = sumNightly(breakdown);
  const adjustments = buildAgentChannelAdjustments({
    nightlySubtotal,
    publicTotal,
    agentTotal,
    packageApplied,
    stayDiscountApplied,
    language,
  });
  // Gap-night line (rate line, never a "discount" word): the folded total
  // departed once more by the host's configured gap-night lever. Emitted only
  // when a real gap adjustment actually changed the number.
  const hasGap =
    typeof gapAdjustedTotal === "number" &&
    Number.isFinite(gapAdjustedTotal) &&
    gapAdjustedTotal !== agentTotal;
  if (hasGap) {
    adjustments.push({
      code: "gap_night_rate",
      label: pickLabel(GAP_NIGHT_RATE_LABEL, language),
      amount: (gapAdjustedTotal as number) - agentTotal,
      scope: "stay",
    });
  }
  // P5: the quoted total is the channel-resolved (and, on a gap night,
  // gap-adjusted) total.
  const quotedTotal = hasGap ? (gapAdjustedTotal as number) : agentTotal;
  const reconciliation = reconcile(breakdown, adjustments, quotedTotal);

  return {
    total: quotedTotal,
    adjustments,
    reconciliation,
    exact: reconciliation.matches_quoted_total,
  };
}

/**
 * Apply the host's OWN direct price by folding the per-channel acquisition lever
 * the host sets in ONE place (property_channel_discounts → matrix.directBookingDiscount,
 * e.g. 5 | 10 | 20) directly into the nightly rates.
 *
 * The point (CEO decision 2026-06-29b): the signed offer shows ONE honest total.
 * There is NO second number and NO "discount"/"savings" line anywhere — only the
 * host sees, in their own dashboard, that they lowered the price. An AI agent or
 * guest sees the (already-direct) total and a nightly breakdown that sums to it.
 *
 * Correctness guarantees (both load-bearing — never weaken without re-checking):
 *  1. `total = round(rackTotal × (1 − pct/100))` is byte-identical to the
 *     agent-channel CHARGE (api/agent/.../reservations.ts + api/ai-gateway/quote.ts
 *     use the same formula and the same matrix.directBookingDiscount), so the
 *     signed offer total always equals what checkout binds → no price_lock 409.
 *  2. Each nightly rate is scaled by the same factor and the rounding RESIDUAL is
 *     absorbed into the last night, so `Σ breakdown.nightly_rate === total`
 *     exactly. The offer then self-reconciles with EMPTY adjustments.
 *
 * pct ≤ 0, null, or a missing rack total / breakdown is a no-op (returns the rack
 * values unchanged). Pure and runtime-agnostic, same as the rest of this module.
 */
export function applyHostDirectPrice<T extends { nightly_rate?: number | null }>(
  breakdown: T[] | null | undefined,
  rackTotal: number | null,
  discountPct: number | null | undefined,
): { total: number | null; breakdown: T[] | null } {
  const rows = Array.isArray(breakdown) ? breakdown : null;
  if (rows === null || rackTotal === null) {
    return { total: rackTotal, breakdown: rows };
  }
  const pct = Number(discountPct);
  if (!Number.isFinite(pct) || pct <= 0) {
    return { total: rackTotal, breakdown: rows };
  }
  const factor = 1 - pct / 100;
  const total = Math.round(rackTotal * factor);
  const scaled = rows.map((night) => ({
    ...night,
    nightly_rate: Math.round((Number(night?.nightly_rate) || 0) * factor),
  }));
  const scaledSum = scaled.reduce((sum, n) => sum + (Number(n.nightly_rate) || 0), 0);
  const residual = total - scaledSum;
  // Only absorb a TRUE rounding residual — the sub-unit drift from rounding each
  // night independently, bounded by ±1 currency unit per night. A LARGER residual
  // means `rackTotal` is a package price (week/two-week) that differs structurally
  // from the nightly sum; that gap is NOT a nightly rate and MUST NOT be dumped
  // into one night (doing so produced a negative nightly_rate — schema-invalid,
  // and nonsense to an agent reading night-by-night). Leave the scaled nightly
  // rates positive; buildAgentChannelAdjustments then surfaces the structural
  // difference as a neutral `package_rate` line and Σ still reconciles to total.
  const roundingBound = scaled.length;
  if (residual !== 0 && Math.abs(residual) <= roundingBound && scaled.length > 0) {
    const last = scaled[scaled.length - 1];
    last.nightly_rate = (Number(last.nightly_rate) || 0) + residual;
  }
  return { total, breakdown: scaled };
}
