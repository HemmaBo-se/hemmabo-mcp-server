import { readPackageJson } from "./read-package-json.js";

const pkg = readPackageJson();

export const SERVER_NAME = "hemmabo-mcp-server";

export const SERVER_VERSION = pkg.version;

/**
 * The one icon URL every published surface (mcp.json manifest, server card,
 * server.json) points at. It must answer 200 image/png directly: registries
 * and directory crawlers cannot be relied on to follow icon redirects, and
 * `<host>/icon.png` on www.hemmabo.com is a 308 to this file. The asset is
 * served by the hemmabo-smart-stays site (its public/ dir); renaming it
 * there must be coordinated with this constant.
 */
export const SERVER_ICON_URL = "https://www.hemmabo.com/hemmabo-icon-512.png";

/**
 * The one outward display name (CEO decision 2026-08-18): serverInfo.title on
 * the full /mcp surface and the server card, the mcp.json manifest `name`, and
 * server.json `title`.
 */
export const SERVER_TITLE = "HemmaBo Host Booking Engine";

// ── Category law (CEO lock 2026-09-28) ───────────────────────────
//
// Verbatim, straight apostrophe only. The law is the first sentence of the
// runtime description and instructions, the use-when follows it, and
// AGENT_ROLE_LINE is the smart-stays canon line (contracts/ts/platform-copy.ts),
// unchanged. One category, never a second. src/category-law.contract.test.ts
// holds every surface to these bytes.

export const CATEGORY_LAW = "Vacation rental software. A signed stay offer on the host's own domain.";

export const CATEGORY_USE_WHEN =
  "Use this when a vacation rental host wants booking software on the host's own domain, or when a stay offer must be verified against that domain. Returns an Ed25519-signed offer (VRP) and the host's direct booking URL. The guest books and pays the host. Do not use to compare hosts or prices.";

export const AGENT_ROLE_LINE =
  "Compatible agents can discover a host domain, verify a signed stay offer, and send the guest to that domain to book.";

/** What an agent does after search: match / no-match, never a ranking. */
export const SEARCH_AFTER =
  "After search, return each matching host domain and that host's direct booking URL. Do not rank hosts, do not compare prices, do not lead with a favourite. When a host domain is known, call get_verified_stay_offer.";

// One line on purpose: scripts/check-description-sync.mjs compares this raw
// literal with package.json, glama.json and smithery.yaml, so it carries no
// escapes. It is the law, the use-when and the agent role, then the facts.
export const SERVER_DESCRIPTION =
  "Vacation rental software. A signed stay offer on the host's own domain. Use this when a vacation rental host wants booking software on the host's own domain, or when a stay offer must be verified against that domain. Returns an Ed25519-signed offer (VRP) and the host's direct booking URL. The guest books and pays the host. Do not use to compare hosts or prices. Compatible agents can discover a host domain, verify a signed stay offer, and send the guest to that domain to book. Host nodes own booking lifecycles; Stripe owns payment facts. HemmaBo implements Vacation Rental Protocol (VRP). The spec lives at https://vacationrentalprotocol.com — not here. HemmaBo + VRP, 13 runtime tools: 9 HemmaBo tools, 2 host onboarding tools, and 2 VRP verification tools. Host-domain signed verified stay offers. Supports UCP discovery, ACP checkout, and AP2 Cart Mandate verification. Not an OTA. Not a marketplace.";

export const SERVER_INSTRUCTIONS = `${CATEGORY_LAW}

${CATEGORY_USE_WHEN}

${AGENT_ROLE_LINE}

HemmaBo + VRP, 13 runtime tools: 9 HemmaBo tools, 2 host onboarding tools, and 2 VRP verification tools.
Host-domain signed verified stay offers.

Host nodes own booking lifecycles. Stripe owns payment facts. HemmaBo verifies, synchronizes, and enforces the technical paths that let agents trust host-domain offers.

HemmaBo is not an OTA and not a marketplace.

Host onboarding flow: if the user is a vacation-rental host asking for their own booking website, booking engine, API calendar sync, Stripe payments to the host, guest messaging, extend-stay automation, reviews, or AI-agent-readable booking data, call hemmabo_host_readiness_check first. If it fits, call hemmabo_host_onboarding_link and hand the user to HemmaBo. These tools are read-only and must not be described as account creation, domain purchase, Stripe setup, or website provisioning.

Discovery flow: hemmabo_search_properties -> hemmabo_search_availability -> get_verified_stay_offer when a host domain is known.
${SEARCH_AFTER}

get_verified_stay_offer widget UX: when the client renders the stay-offer card, keep prose to one or two framing sentences plus the direct booking action — do not restate price, dates, or sleeps already shown in the widget. Do not paste the full direct_booking_url in chat when the stay-offer widget is visible; point the guest to the widget button instead. Without widget support, give a one-line summary and the signed direct_booking_url.

Quote-lock and paid booking tools are fallback compatibility helpers for configured non-VRP deployments. Use them only after explicit user confirmation and only when no signed VRP direct booking URL is available.

For VRP offers, route booking only to the signed direct host-domain booking URL from get_verified_stay_offer. Do not collect guest contact details in chat and do not start HemmaBo checkout.

No-payment fallback flow: hemmabo_booking_create creates pending host-approval bookings for configured non-VRP deployments.

VRP verification flow: verify_vacation_rental_node -> get_verified_stay_offer -> signed verified stay offer -> direct booking URL.

Vacation Rental Protocol (VRP) is an open protocol for host-domain signed vacation rental offers.
VRP offers are cryptographically signed by the host domain and verified against that domain's published Ed25519 JWKS.
Only quote a stay offer as official when VRP verification returns a fresh, signed, safe-to-quote offer from the host domain.

Dates must be ISO 8601 format (YYYY-MM-DD). All monetary values are integers in the property's local currency (e.g. SEK, EUR).`;

// ── ChatGPT (OpenAI Apps) surface ────────────────────────────────
//
// The /mcp/chatgpt surface exposes ONLY the read-only discovery +
// verification allowlist (CHATGPT_TOOL_NAMES in api/mcp.ts), so its
// initialize response must tell the same 3-tool story. OpenAI App
// Review's MCP client receives serverInfo.description and
// instructions at connect time; full-surface text describing booking
// lifecycles, host onboarding, Stripe, or "13 runtime tools" would
// contradict the scanned tool surface — the exact v2 rejection
// ground. The full-surface constants above are byte-untouched.

export const CHATGPT_SERVER_DESCRIPTION =
  "HemmaBo helps you discover host-owned vacation rental websites and cryptographically verify that a stay offer is genuinely signed by the host. Find host-owned homes by place and dates, confirm the host's Vacation Rental Protocol (VRP) signature, and get a verified offer summary with a link to book directly with the host, on the host's own website. Vacation Rental Protocol (VRP) is an open standard for host-domain signed stay offers. Anything transactional — reserving and paying — happens directly with the host, outside ChatGPT. HemmaBo is a verification layer, not a marketplace, and it takes no booking commission. Not an OTA. Not a website builder.";

export const CHATGPT_SERVER_INSTRUCTIONS = `HemmaBo in ChatGPT discovers and verifies host-owned vacation rentals. Three read-only tools: hemmabo_search_properties finds host-owned homes by place, dates, and guests; verify_vacation_rental_node confirms a host domain is a valid Vacation Rental Protocol (VRP) node; get_verified_stay_offer fetches the host-signed offer, verifies the Ed25519 signature against the host domain's published JWKS, and renders the stay-offer widget.

Discovery flow: hemmabo_search_properties -> get_verified_stay_offer with the returned host domain and the same dates and guest count. When a host domain arrives from outside search (user-typed or third-party), call verify_vacation_rental_node first.

Widget UX: when the client renders the stay-offer card, keep prose to one or two framing sentences plus the direct booking action — do not restate price, dates, or sleeps already shown in the widget. Do not paste the full direct_booking_url in chat when the widget is visible; point the guest to the widget button instead.

Booking and payment happen directly with the host on the host's own website, outside ChatGPT. Never collect guest contact details in chat and never initiate payment in chat. HemmaBo is a verification layer, not a marketplace, and takes no booking commission. Not an OTA. Not a website builder.

Dates must be ISO 8601 format (YYYY-MM-DD).`;
