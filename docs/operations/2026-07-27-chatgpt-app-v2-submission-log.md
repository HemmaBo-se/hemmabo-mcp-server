# ChatGPT App v2.0.0 — filed 2026-07-27 (submission log)

**Status at filing:** v2.0.0 "Review" · **v1.0.0 "Published (View in Directory)"**
— the earlier withdrawal did NOT unpublish 1.0.0; the app is publicly listed
while 2.0.0 is reviewed, and approval of 2.0.0 REPLACES the stale public
listing. This log records exactly what OpenAI received, so any review answer
can be checked against what was actually filed.

## What was filed (final field values)

- **Description:** the gated JSON text — **13 runtime tools (9 federation +
  2 host onboarding + 2 VRP verification)**, "host-owned vacation rental
  websites", "Not an OTA. Not a marketplace. Not a website builder."
  The stale 15/11 counts were caught in the form draft and corrected before
  submission (parity gate: 647/647 the same day).
- **Website URL:** https://www.hemmabo.com (canonical www, matching did:web).
- **Support / Privacy / Terms:** https://www.hemmabo.com/contact · /privacy · /terms.
- **Developer identity:** the OpenAI-verified business identity; public
  author name "HemmaBo".
- **Test cases (exactly 5, form limit):** search / availability / quote /
  verify node / verified stay offer. TC1 rewritten before filing: "Use
  HemmaBo to find direct-bookable **host-owned** vacation rentals…" — the
  possessive "HemmaBo properties" framing was caught BY THE CEO and purged
  (also synced to the canonical JSON in #295). All five were executed against
  production via live MCP the same day: all passed, including the 1-night
  November window (3 060 SEK signed offer).
- **Negative test cases (exactly 3, form limit):** Hilton chain hotel ·
  "Find all hotels in Paris" · "Compare Expedia packages" — the three
  nearest-boundary cases; "Book a flight" and "General travel tips" were
  dropped as too-far-from-scope to prove anything (canonical JSON keeps all
  five).
- **Release notes:** corrected before submit — 13 tools (not 15),
  "host-owned vacation rentals" (not "HemmaBo properties"), and "verification
  requires no central issuer" (not "no central registry" — the federation
  registry EXISTS for discovery; it is verification that needs no gatekeeper).
- **Demo video (Loom, ~3 min, Developer Mode):** the 7 positive prompts in
  sequence with rendered widget + "Continue on the host's site" handoff +
  "What do you mean verified?" honesty answer, plus the 3 negative prompts
  showing NO app trigger. OpenAI's free-tier credits banner appears at the
  very tail; assessed cosmetic (OpenAI's own UI, after all substance) and
  filed as-is.
- **Commerce declarations:** links out of ChatGPT for purchases; no digital
  goods; guest pays the host directly on the host's own Stripe; physical
  lodging only.

## Discovery evidence captured during filing (keep)

Testing the TC1 prompt WITHOUT the app enabled, ChatGPT (web-search mode)
found villaakerlyckan.se directly, described it as "Direct booking with the
host via the host-owned domain (HemmaBo/VRP verified)", cited the node's own
site, and estimated "about 2,800–6,000 SEK/night". Node-direct discovery is
working in the wild — and the app's value proposition in one line: without
the app an estimate, with the app the signed exact total (3 060 SEK,
bookable). Differences observed: "pet-friendly" (signed truth: dogs yes,
cats no), OTA vocabulary ("listing"), no widget, no signature.

## Next

- OpenAI notifies on decision; status under "View Plugin Status".
- If approved: verify the LIVE directory listing bytes against this log
  (charter: live bytes, never notes).
- If rejected: the answer must name a field — every field above has a
  verified source to check it against.
