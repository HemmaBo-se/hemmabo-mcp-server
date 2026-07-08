// CEO-LOCKED guest source-boundary copy (2026-07-08) — MIRROR.
//
// Source of truth: hemmabo-smart-stays contracts/ts/vrp-trust-copy.ts +
// docs/CANONICAL_TRUST_LAYER_COPY.md (section 4b). The strings below must stay
// BYTE-IDENTICAL to the SoT — never edit here without editing the SoT first
// (trusted-layer ADR governance). sv + en are CEO-locked verbatim; the other
// ten are translated from the locked meaning and marked PENDING native
// review in the canonical doc. English is the explicit fallback.
//
// Agents relay this text VERBATIM in the guest's language when introducing
// a verified stay — it is the node's own welcome, not agent-authored prose.

export const SOURCE_BOUNDARY_GUEST: Record<string, string> = {
  sv: "V\u00e4lkommen till {nameGenitive} egen officiella bokningssida. H\u00e4r bokar du direkt hos v\u00e4rden \u2013 utan mellanh\u00e4nder. Priset du ser kommer direkt fr\u00e5n v\u00e4rden och betalningen g\u00e5r direkt till v\u00e4rden. All information p\u00e5 denna sida kan verifieras \u2013 \u00e4ven av AI-assistenter.",
  en: "Welcome to {nameGenitive} own official booking page. Here you book directly with the host \u2013 no middlemen. The price you see comes directly from the host and your payment goes directly to the host. Everything on this page can be verified \u2013 including by AI assistants.",
  de: "Willkommen auf der eigenen offiziellen Buchungsseite von {name}. Hier buchen Sie direkt beim Gastgeber \u2013 ohne Zwischenh\u00e4ndler. Der Preis, den Sie sehen, kommt direkt vom Gastgeber und Ihre Zahlung geht direkt an den Gastgeber. Alles auf dieser Seite kann \u00fcberpr\u00fcft werden \u2013 auch von KI-Assistenten.",
  fr: "Bienvenue sur la page de r\u00e9servation officielle de {name}. Ici, vous r\u00e9servez directement aupr\u00e8s de l'h\u00f4te \u2013 sans interm\u00e9diaires. Le prix affich\u00e9 vient directement de l'h\u00f4te et votre paiement va directement \u00e0 l'h\u00f4te. Tout sur cette page peut \u00eatre v\u00e9rifi\u00e9 \u2013 y compris par des assistants IA.",
  da: "Velkommen til {nameGenitive} egen officielle bookingside. Her booker du direkte hos v\u00e6rten \u2013 uden mellemled. Prisen, du ser, kommer direkte fra v\u00e6rten, og din betaling g\u00e5r direkte til v\u00e6rten. Alt p\u00e5 denne side kan verificeres \u2013 ogs\u00e5 af AI-assistenter.",
  no: "Velkommen til {nameGenitive} egen offisielle bookingside. Her booker du direkte hos verten \u2013 uten mellomledd. Prisen du ser, kommer direkte fra verten, og betalingen g\u00e5r direkte til verten. Alt p\u00e5 denne siden kan verifiseres \u2013 ogs\u00e5 av AI-assistenter.",
  fi: "Tervetuloa kohteen {name} omalle viralliselle varaussivulle. T\u00e4\u00e4ll\u00e4 varaat suoraan is\u00e4nn\u00e4lt\u00e4 \u2013 ilman v\u00e4lik\u00e4si\u00e4. N\u00e4kem\u00e4si hinta tulee suoraan is\u00e4nn\u00e4lt\u00e4 ja maksusi menee suoraan is\u00e4nn\u00e4lle. Kaikki t\u00e4ll\u00e4 sivulla voidaan todentaa \u2013 my\u00f6s teko\u00e4lyavustajien toimesta.",
  nl: "Welkom op de eigen offici\u00eble boekingspagina van {name}. Hier boek je rechtstreeks bij de gastheer \u2013 zonder tussenpersonen. De prijs die je ziet komt rechtstreeks van de gastheer en je betaling gaat rechtstreeks naar de gastheer. Alles op deze pagina kan worden geverifieerd \u2013 ook door AI-assistenten.",
  es: "Bienvenido a la p\u00e1gina de reservas oficial de {name}. Aqu\u00ed reservas directamente con el anfitri\u00f3n \u2013 sin intermediarios. El precio que ves viene directamente del anfitri\u00f3n y tu pago va directamente al anfitri\u00f3n. Todo en esta p\u00e1gina puede verificarse \u2013 tambi\u00e9n por asistentes de IA.",
  it: "Benvenuto nella pagina di prenotazione ufficiale di {name}. Qui prenoti direttamente con l'host \u2013 senza intermediari. Il prezzo che vedi arriva direttamente dall'host e il tuo pagamento va direttamente all'host. Tutto su questa pagina pu\u00f2 essere verificato \u2013 anche dagli assistenti IA.",
  pl: "Witamy na oficjalnej stronie rezerwacji obiektu {name}. Tutaj rezerwujesz bezpo\u015brednio u gospodarza \u2013 bez po\u015bredni\u00f3w. Cena, kt\u00f3r\u0105 widzisz, pochodzi bezpo\u015brednio od gospodarza, a p\u0142atno\u015b\u0107 trafia bezpo\u015brednio do gospodarza. Wszystko na tej stronie mo\u017cna zweryfikowa\u0107 \u2013 tak\u017ce przez asystent\u00f3w AI.",
  ar: "\u0645\u0631\u062d\u0628\u064b\u0627 \u0628\u0643 \u0641\u064a \u0635\u0641\u062d\u0629 \u0627\u0644\u062d\u062c\u0632 \u0627\u0644\u0631\u0633\u0645\u064a\u0629 \u0627\u0644\u062e\u0627\u0635\u0629 \u0628\u0640{name}. \u0647\u0646\u0627 \u062a\u062d\u062c\u0632 \u0645\u0628\u0627\u0634\u0631\u0629 \u0644\u062f\u0649 \u0627\u0644\u0645\u0636\u064a\u0641 \u2013 \u062f\u0648\u0646 \u0648\u0633\u0637\u0627\u0621. \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0630\u064a \u062a\u0631\u0627\u0647 \u064a\u0623\u062a\u064a \u0645\u0628\u0627\u0634\u0631\u0629 \u0645\u0646 \u0627\u0644\u0645\u0636\u064a\u0641\u060c \u0648\u062f\u0641\u0639\u062a\u0643 \u062a\u0630\u0647\u0628 \u0645\u0628\u0627\u0634\u0631\u0629 \u0625\u0644\u0649 \u0627\u0644\u0645\u0636\u064a\u0641. \u0643\u0644 \u0645\u0627 \u0641\u064a \u0647\u0630\u0647 \u0627\u0644\u0635\u0641\u062d\u0629 \u0642\u0627\u0628\u0644 \u0644\u0644\u062a\u062d\u0642\u0642 \u2013 \u062d\u062a\u0649 \u0645\u0646 \u0642\u0650\u0628\u0644 \u0645\u0633\u0627\u0639\u062f\u064a \u0627\u0644\u0630\u0643\u0627\u0621 \u0627\u0644\u0627\u0635\u0637\u0646\u0627\u0639\u064a.",
};

/** Swedish-model genitive: append "s" unless the name ends in s/x/z. */
export function svGenitive(name: string): string {
  const trimmed = name.trim();
  return /[sxz]$/i.test(trimmed) ? trimmed : `${trimmed}s`;
}

/** English genitive: name + "'s", or just "'" when it already ends in s. */
export function enGenitive(name: string): string {
  const trimmed = name.trim();
  return /s$/i.test(trimmed) ? `${trimmed}'` : `${trimmed}'s`;
}

function guestBlockName(locale: string, propertyName: string): string {
  if (locale === "sv" || locale === "da" || locale === "no") return svGenitive(propertyName);
  if (locale === "en") return enGenitive(propertyName);
  return propertyName.trim();
}

/** The guest-facing source-boundary block for ONE locale (en fallback). */
export function sourceBoundaryGuestBlock(locale: string, propertyName: string): string {
  const lang = SOURCE_BOUNDARY_GUEST[locale] ? locale : "en";
  const template = SOURCE_BOUNDARY_GUEST[lang];
  const name = guestBlockName(lang, propertyName);
  return template.replace("{nameGenitive}", name).replace("{name}", name);
}

/** All locales interpolated for the agent payload (guest_welcome.by_locale). */
export function guestWelcomeByLocale(propertyName: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const locale of Object.keys(SOURCE_BOUNDARY_GUEST)) {
    out[locale] = sourceBoundaryGuestBlock(locale, propertyName);
  }
  return out;
}
