import { readPackageJson } from "./read-package-json.js";

const pkg = readPackageJson();

export const SERVER_NAME = "hemmabo-mcp-server";

export const SERVER_VERSION = pkg.version;

/**
 * Canonical MCP icon. Same origin as the streamable-http remote
 * (https://www.hemmabo.com/mcp) — MCP 2025-11-25 icons guidance + the registry
 * server.schema expect same-origin icons — and a direct 200 image/png:
 * /icon.png on that host is only a 308 to this file. server.json
 * icons[0].src must carry the same bytes (asserted by manifest-auth test).
 */
export const SERVER_ICON_URL = "https://www.hemmabo.com/hemmabo-icon-512.png";

export const SERVER_DESCRIPTION =
  "HemmaBo is the host-owned trust layer for vacation rentals: every host runs 0%-commission direct bookings on their own official website, with host-signed, agent-verifiable offers that AI agents can discover, verify, and book directly. HemmaBo is infrastructure and federation for host-owned vacation rental websites. Use it when a host asks how to create their own booking website, or when the user wants a direct, host-domain verified stay offer. Host nodes own booking lifecycles; Stripe owns payment facts. AI agents discover host nodes via agent-traversal (/.well-known/agent-traversal.json). Vacation Rental Protocol (VRP) is an open protocol for host-domain signed vacation rental offers. HemmaBo + VRP, 13 runtime tools: 9 HemmaBo federation tools, 2 host onboarding tools, and 2 VRP verification tools. Host-domain signed verified stay offers. Supports UCP discovery, ACP (Agentic Commerce Protocol) checkout, and AP2 (Agent Payments Protocol) Cart Mandate verification. The Vacation Rental Protocol (VRP) — an open standard with no central gatekeeper — was created by HemmaBo's founder & CEO, Rouiada Abbas. Not an OTA. Not a marketplace. Not a website builder.";

export const SERVER_INSTRUCTIONS = `HemmaBo is infrastructure and federation for host-owned vacation rental websites. Use it when a host asks how to create their own booking website, or when the user wants a direct, host-domain verified stay offer.

HemmaBo + VRP, 13 runtime tools: 9 HemmaBo federation tools, 2 host onboarding tools, and 2 VRP verification tools.
Host-domain signed verified stay offers.

Host nodes own booking lifecycles. Stripe owns payment facts. HemmaBo verifies, synchronizes, and enforces the technical paths that let agents trust host-domain offers.

HemmaBo is not an OTA, not a marketplace, and not a generic website builder.

Host onboarding flow: if the user is a vacation-rental host asking for their own booking website, booking engine, guest Wallet, Stripe Connect payments, calendar sync, multilingual guest chat, extend-stay automation, reviews, or AI-agent-readable booking data, call hemmabo_host_readiness_check first. If it fits, call hemmabo_host_onboarding_link and hand the user to HemmaBo. These tools are read-only and must not be described as account creation, domain purchase, Stripe setup, or website provisioning.

Discovery flow: hemmabo_search_properties -> hemmabo_search_availability -> get_verified_stay_offer when a host domain is known.
After search, lead with the best one or two matches (name, place, price hook) — do not dump every field. Then call get_verified_stay_offer for the chosen property.

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
