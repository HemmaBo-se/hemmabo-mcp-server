/**
 * Display-grade currency translation for the stay-offer surface.
 *
 * ADR (smart-stays) `docs/DECISIONS/2026-08-06-currency-display-translation-approx.md`:
 * charging ALWAYS happens in the node currency — one price, all countries,
 * exactly what the host set. A guest surface may additionally show a
 * TRANSLATED figure, but only marked approximate (≈) with the original
 * amount visible, never as an exact foreign price: the guest's bank sets
 * the final statement figure, not us. The translation is an annotation
 * BESIDE the signed VRP offer — never a field inside it, never a second
 * offer.
 *
 * Rates are ECB reference via Frankfurter, fetched through the vendored
 * fx-core (node currency as base). Display grade: cached 4 h, and any
 * failure simply omits the translation — it never blocks or delays the
 * verified offer itself.
 */

import {
  buildFrankfurterUrl,
  convertForDisplay,
  isValidIso4217,
  type FxSnapshot,
} from "./fx-core.js";

/** Mirror of smart-stays `src/lib/region.ts` LANG_TO_CURRENCY — the same
 * guest-language → display-currency mapping the node's own pages use. */
const LANG_TO_CURRENCY: Record<string, string> = {
  sv: "SEK", da: "DKK", no: "NOK", fi: "EUR",
  de: "EUR", fr: "EUR", nl: "EUR", it: "EUR", es: "EUR",
  pl: "PLN", en: "USD",
};

export function guestCurrencyForLanguage(language: string): string {
  return LANG_TO_CURRENCY[language.toLowerCase()] ?? "EUR";
}

/** Mirror of smart-stays `src/lib/forexNoteI18n.ts` — the localized ≈-note
 * shown next to a translated price on every guest surface. */
interface ForexNoteStrings {
  note: string;
  tooltip: string;
  originalLabel: string;
}

const FOREX_NOTES: Record<string, ForexNoteStrings> = {
  sv: {
    note: "Ungefärlig kurs via ECB",
    tooltip: "Ungefärligt pris baserat på ECB:s dagskurs. Slutpris debiteras i värdvaluta.",
    originalLabel: "Original",
  },
  en: {
    note: "Approximate rate via ECB",
    tooltip: "Approximate price based on ECB daily rate. Final charge in property currency.",
    originalLabel: "Original",
  },
  de: {
    note: "Ungefährer Kurs via EZB",
    tooltip: "Ungefährer Preis basierend auf dem EZB-Tageskurs. Endabrechnung in der Objektwährung.",
    originalLabel: "Original",
  },
  fr: {
    note: "Taux approximatif via BCE",
    tooltip: "Prix approximatif basé sur le taux journalier de la BCE. Facturation finale dans la devise du logement.",
    originalLabel: "Original",
  },
  es: {
    note: "Tipo aproximado vía BCE",
    tooltip: "Precio aproximado basado en el tipo de cambio diario del BCE. Cobro final en la moneda del alojamiento.",
    originalLabel: "Original",
  },
  nl: {
    note: "Indicatieve koers via ECB",
    tooltip: "Indicatieve prijs op basis van de dagkoers van de ECB. Definitieve afrekening in de valuta van de accommodatie.",
    originalLabel: "Origineel",
  },
  da: {
    note: "Omtrentlig kurs via ECB",
    tooltip: "Omtrentlig pris baseret på ECB's dagskurs. Endelig debitering sker i ejendommens valuta.",
    originalLabel: "Original",
  },
  no: {
    note: "Omtrentlig kurs via ECB",
    tooltip: "Omtrentlig pris basert på ECBs dagskurs. Endelig belastning i utleiers valuta.",
    originalLabel: "Original",
  },
  fi: {
    note: "Likimääräinen kurssi EKP:n mukaan",
    tooltip: "Likimääräinen hinta EKP:n päiväkurssin mukaan. Lopullinen veloitus kohteen valuutassa.",
    originalLabel: "Alkuperäinen",
  },
  it: {
    note: "Tasso approssimativo via BCE",
    tooltip: "Prezzo approssimativo basato sul tasso giornaliero BCE. Addebito finale nella valuta della struttura.",
    originalLabel: "Originale",
  },
  pl: {
    note: "Przybliżony kurs wg EBC",
    tooltip: "Przybliżona cena na podstawie dziennego kursu EBC. Ostateczna płatność w walucie obiektu.",
    originalLabel: "Oryginalnie",
  },
  ar: {
    note: "سعر تقريبي عبر البنك المركزي الأوروبي",
    tooltip: "سعر تقريبي بناءً على السعر اليومي للبنك المركزي الأوروبي. يتم الخصم النهائي بعملة العقار.",
    originalLabel: "الأصلي",
  },
};

export function forexNoteForLanguage(language: string): ForexNoteStrings {
  return FOREX_NOTES[language.toLowerCase()] ?? FOREX_NOTES.en;
}

// ── Display-rate cache (per base->quote pair, 4 h — same TTL as the node's
// own /api/forex-rates). Display grade only: a miss or failure returns null
// and the offer simply carries no translation.
const DISPLAY_TTL_MS = 4 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3500;

interface CachedRate {
  snapshot: FxSnapshot;
  cachedAtMs: number;
}

const rateCache = new Map<string, CachedRate>();

export async function fetchDisplayRate(
  base: string,
  quote: string,
): Promise<FxSnapshot | null> {
  if (!isValidIso4217(base) || !isValidIso4217(quote) || base === quote) return null;
  const key = `${base}->${quote}`;
  const cached = rateCache.get(key);
  const now = Date.now();
  if (cached && now - cached.cachedAtMs < DISPLAY_TTL_MS) return cached.snapshot;
  try {
    const url = buildFrankfurterUrl(base, [quote]);
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return cached?.snapshot ?? null;
    const body = (await response.json()) as { rates?: Record<string, unknown> };
    const rate = Number(body?.rates?.[quote]);
    if (!Number.isFinite(rate) || rate <= 0) return cached?.snapshot ?? null;
    const snapshot: FxSnapshot = {
      base,
      quote,
      rate,
      source: "ecb-frankfurter",
      fetchedAt: new Date(now).toISOString(),
    };
    rateCache.set(key, { snapshot, cachedAtMs: now });
    return snapshot;
  } catch {
    return cached?.snapshot ?? null;
  }
}

/**
 * Build the display-only translated-price block for a stay offer. Pure.
 * Returns null when no translation applies. The block is an ANNOTATION —
 * consumers must render it as ≈ with the original beside it, and it must
 * never enter the signed payload or be presented as the chargeable price.
 */
export function buildApproxGuestPrice(
  totalWholeUnits: number,
  nodeCurrency: string,
  language: string,
  snapshot: FxSnapshot,
): Record<string, unknown> | null {
  if (!Number.isFinite(totalWholeUnits) || totalWholeUnits <= 0) return null;
  if (snapshot.base !== nodeCurrency || snapshot.base === snapshot.quote) return null;
  const strings = forexNoteForLanguage(language);
  return {
    currency: snapshot.quote,
    total: convertForDisplay(totalWholeUnits, snapshot),
    approximate: true,
    note: strings.note,
    tooltip: strings.tooltip,
    original_label: strings.originalLabel,
    original: { currency: nodeCurrency, total: totalWholeUnits },
    rate_source: "ecb-frankfurter",
    rate_date: snapshot.fetchedAt.slice(0, 10),
  };
}
