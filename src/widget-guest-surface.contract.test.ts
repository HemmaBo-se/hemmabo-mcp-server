/**
 * Widget guest surface — regression suite for the mobile report 2026-07-08.
 *
 * What the guest saw on Claude web (mobile): the CTA link did nothing when
 * tapped, the unfold panel clipped without scrolling, the hero image never
 * changed (the property page rotates its gallery), and the CEO-locked guest
 * welcome copy (smart-stays #2076/#2077) was absent from the offer surface.
 *
 * Root causes pinned here:
 *  1. The CTA handler did e.preventDefault() + window.open() — sandboxed
 *     mobile webviews block window.open, so the tap was dead. Now the
 *     handler only intercepts when the Apps host handles the open
 *     (tryHostOpen); otherwise the native anchor navigates.
 *  2. normalizeOffer stopped collecting images after the FIRST source that
 *     yielded one ("if (image) break") — the carousel/gallery got 1 image.
 *  3. No rotation existed at all; startCarousel now cycles the hero.
 *  4. The unfold panel was overflow:hidden at a fixed max-height.
 *  5. The guest welcome block is CEO-LOCKED copy — the widget and the agent
 *     payload must carry it byte-identical to the smart-stays SoT
 *     (docs/CANONICAL_TRUST_LAYER_COPY.md §4b), never paraphrased.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SOURCE_BOUNDARY_GUEST,
  enGenitive,
  sourceBoundaryGuestBlock,
  guestWelcomeByLocale,
  svGenitive,
} from "../lib/vrp-trust-copy.js";
import { VERIFIED_STAY_OFFER_HTML } from "../lib/apps-widget-html.js";
import { HEMMABO_PREVIOUS_WIDGET_URI, HEMMABO_WIDGET_URI } from "../lib/apps-widget.js";

describe("CEO-locked guest welcome copy (mirror of smart-stays vrp-trust-copy)", () => {
  it("sv is character-exact (CEO-locked 2026-07-08)", () => {
    assert.equal(
      sourceBoundaryGuestBlock("sv", "Villa Åkerlyckan"),
      "Välkommen till Villa Åkerlyckans egen officiella bokningssida. Här bokar du direkt hos värden – utan mellanhänder. Priset du ser kommer direkt från värden och betalningen går direkt till värden. All information på denna sida kan verifieras – även av AI-assistenter.",
    );
  });

  it("en is character-exact (CEO-locked 2026-07-08)", () => {
    assert.equal(
      sourceBoundaryGuestBlock("en", "Villa Åkerlyckan"),
      "Welcome to Villa Åkerlyckan's own official booking page. Here you book directly with the host – no middlemen. The price you see comes directly from the host and your payment goes directly to the host. Everything on this page can be verified – including by AI assistants.",
    );
  });

  it("genitive template rule: names already ending in s/x/z get no extra s", () => {
    assert.equal(svGenitive("Villa Fyros"), "Villa Fyros");
    assert.equal(svGenitive("Villa Åkerlyckan"), "Villa Åkerlyckans");
    assert.equal(enGenitive("Villa Fyros"), "Villa Fyros'");
    assert.equal(enGenitive("Villa Åkerlyckan"), "Villa Åkerlyckan's");
  });

  it("unknown locale falls back to the ENGLISH template AND English genitive", () => {
    assert.equal(
      sourceBoundaryGuestBlock("xx", "Villa Åkerlyckan"),
      sourceBoundaryGuestBlock("en", "Villa Åkerlyckan"),
    );
  });

  it("covers all 12 supported languages and interpolates everywhere", () => {
    const byLocale = guestWelcomeByLocale("Villa Åkerlyckan");
    assert.equal(Object.keys(byLocale).length, 12);
    for (const [locale, text] of Object.entries(byLocale)) {
      assert.ok(text.includes("Villa Åkerlyckan"), locale);
      assert.ok(!text.includes("{name"), `${locale} left a template placeholder`);
    }
  });
});

describe("widget carries the locked guest copy byte-identical", () => {
  const guestCopySection = VERIFIED_STAY_OFFER_HTML.match(/var GUEST_COPY = \{([\s\S]*?)\n {2}\};/);

  it("embeds a GUEST_COPY table", () => {
    assert.ok(guestCopySection, "widget must embed GUEST_COPY");
  });

  it("every locale template equals the mirror module exactly", () => {
    for (const [locale, template] of Object.entries(SOURCE_BOUNDARY_GUEST)) {
      const line = (guestCopySection as RegExpMatchArray)[1].match(
        new RegExp(`\\b${locale}: ("(?:[^"\\\\]|\\\\.)*")`),
      );
      assert.ok(line, `widget missing locale ${locale}`);
      assert.equal(JSON.parse((line as RegExpMatchArray)[1]), template, locale);
    }
  });

  it("renders the pitch into the unfold panel (both layouts)", () => {
    const hits = VERIFIED_STAY_OFFER_HTML.match(/pitchHtml \+ galHtml/g) ?? [];
    assert.equal(hits.length, 2, "pitch must precede the gallery in inline AND fullscreen");
  });
});

describe("widget mobile behaviour", () => {
  it("REGRESSION: CTA never dead-clicks — intercept only when the Apps host opens the link", () => {
    assert.ok(!VERIFIED_STAY_OFFER_HTML.includes("window.open("), "window.open is blocked in sandboxed mobile webviews — the native anchor must be the fallback");
    assert.match(VERIFIED_STAY_OFFER_HTML, /if \(tryHostOpen\(bookUrl\)\) e\.preventDefault\(\);/);
  });

  it("verify seal is a real anchor (native navigation on mobile)", () => {
    assert.match(VERIFIED_STAY_OFFER_HTML, /<a id="verifySeal"[^>]*href="' \+ esc\(verifyUrl\)/);
    assert.match(VERIFIED_STAY_OFFER_HTML, /if \(tryHostOpen\(verifyUrl\)\) e\.preventDefault\(\);/);
  });

  it("REGRESSION: image collection no longer stops at the first source", () => {
    assert.ok(!VERIFIED_STAY_OFFER_HTML.includes("if (image) break;"));
  });

  it("hero rotates via startCarousel and respects prefers-reduced-motion", () => {
    assert.match(VERIFIED_STAY_OFFER_HTML, /function startCarousel\(/);
    assert.match(VERIFIED_STAY_OFFER_HTML, /startCarousel\(heroMain, heroList\);/);
    assert.match(VERIFIED_STAY_OFFER_HTML, /prefers-reduced-motion/);
  });

  it("unfold panel scrolls when open instead of clipping", () => {
    assert.match(VERIFIED_STAY_OFFER_HTML, /\.unfold\.open \{ overflow-y: auto; \}/);
    assert.match(VERIFIED_STAY_OFFER_HTML, /classList\.toggle\("open", hbUnfolded\)/);
  });
});

describe("widget URI bumped so connected hosts refetch the fixed HTML", () => {
  it("current is v9, previous is v8", () => {
    assert.equal(HEMMABO_WIDGET_URI, "ui://hemmabo/verified-stay-offer-v9.html");
    assert.equal(HEMMABO_PREVIOUS_WIDGET_URI, "ui://hemmabo/verified-stay-offer-v8.html");
  });
});

describe("W5c villkorssymmetrin — starred card row, cancellation line, term groups", () => {
  it("compact card prefers the host's starred claims and falls back to amenities", () => {
    assert.match(VERIFIED_STAY_OFFER_HTML, /asArray\(offer\.starred\)\.length\s*\?\s*asArray\(offer\.starred\)\.join\(" · "\)/);
  });

  it("card carries one verbatim cancellation line from the signed ladder (never tier names)", () => {
    assert.match(VERIFIED_STAY_OFFER_HTML, /function cancelLine\(/);
    assert.match(VERIFIED_STAY_OFFER_HTML, /Avboka fritt till \{h\} h före incheckning/);
    assert.match(VERIFIED_STAY_OFFER_HTML, /% återbetalning senast \{h\} h före incheckning/);
    // Never re-labelled into named tiers.
    assert.doesNotMatch(VERIFIED_STAY_OFFER_HTML, /flexible|moderate|strict cancellation/i);
  });

  it("unfolded view renders the three quiet groups from SIGNED terms, chips only as legacy fallback", () => {
    assert.match(VERIFIED_STAY_OFFER_HTML, /function termGroupsHtml\(/);
    assert.match(VERIFIED_STAY_OFFER_HTML, /var groupsHtml = termGroupsHtml\(offer, T\);/);
    assert.match(VERIFIED_STAY_OFFER_HTML, /groupsHtml\s*\?\s*groupsHtml/);
    assert.match(VERIFIED_STAY_OFFER_HTML, /Bra att veta/);
    assert.match(VERIFIED_STAY_OFFER_HTML, /Det här ingår/);
    assert.match(VERIFIED_STAY_OFFER_HTML, /Good to know/);
  });

  it("term labels mirror smart-stays booking-terms-email vocabulary byte-for-byte (sv)", () => {
    // One source by test, not by import: these strings MUST stay identical
    // to contracts/ts/booking-terms-email.ts in hemmabo-smart-stays.
    for (const s of [
      "Sängkläder ingår",
      "Handdukar ingår",
      "Frukost ingår",
      "Slutstädning",
      "Välkomstpaket",
      "Rökning inomhus",
      "Minsta ålder",
    ]) {
      assert.ok(VERIFIED_STAY_OFFER_HTML.includes(s), s);
    }
  });

  it("signed terms surface in normalizeOffer absence-safely (older nodes unchanged)", () => {
    assert.match(VERIFIED_STAY_OFFER_HTML, /terms: \(summary\.terms && typeof summary\.terms === "object"\) \? summary\.terms : null/);
    assert.match(VERIFIED_STAY_OFFER_HTML, /minAge: \(typeof summary\.minimum_guest_age === "number"/);
    assert.match(VERIFIED_STAY_OFFER_HTML, /refund: Array\.isArray\(summary\.refund_schedule\)/);
  });
});

describe("agent payload carries the locked welcome with a verbatim rule", () => {
  const vrpSource = readFileSync(new URL("../lib/vrp.ts", import.meta.url), "utf-8");

  it("get_verified_stay_offer includes guest_welcome.by_locale", () => {
    assert.match(vrpSource, /guest_welcome: nodeName/);
    assert.match(vrpSource, /guestWelcomeByLocale\(nodeName\)/);
  });

  it("the rule forbids rewriting the CEO-locked copy", () => {
    assert.match(vrpSource, /VERBATIM \(fallback: en\)\. Never rewrite, shorten, paraphrase, or machine-translate/);
  });
});
