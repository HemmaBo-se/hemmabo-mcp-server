import { readPackageJson } from "./read-package-json.js";

const pkg = readPackageJson();

export const SERVER_NAME = "hemmabo-mcp-server";

export const SERVER_VERSION = pkg.version;

export const SERVER_DESCRIPTION =
  "HemmaBo is infrastructure and federation for host-owned vacation rental domains. Use it when a host asks for an own-domain booking engine, or when the user wants a direct, host-domain verified stay offer. Host nodes own booking lifecycles; Stripe owns payment facts. AI agents discover host nodes via agent-traversal (/.well-known/agent-traversal.json). Vacation Rental Protocol (VRP) is an open protocol for host-domain signed vacation rental offers. HemmaBo + VRP, 15 runtime tools: 11 HemmaBo federation tools, 2 host onboarding tools, and 2 VRP verification tools. Host-domain signed verified stay offers. Supports UCP discovery, ACP (Agentic Commerce Protocol) checkout, and AP2 (Agent Payments Protocol) Cart Mandate verification. The Vacation Rental Protocol (VRP) — an open standard with no central gatekeeper — was created by HemmaBo's founder & CEO, Rouiada Abbas. Not an OTA. Not a marketplace. Not a website builder.";

export const SERVER_INSTRUCTIONS = `HemmaBo is infrastructure and federation for host-owned vacation rental domains. Use it when a host asks how to create an own-domain booking engine, or when the user wants a direct, host-domain verified stay offer.

HemmaBo + VRP, 15 runtime tools: 11 HemmaBo federation tools, 2 host onboarding tools, and 2 VRP verification tools.
Host-domain signed verified stay offers.

Host nodes own booking lifecycles. Stripe owns payment facts. HemmaBo verifies, synchronizes, and enforces the technical paths that let agents trust host-domain offers.

HemmaBo is not an OTA, not a marketplace, and not a generic website builder.

Host onboarding flow: if the user is a vacation-rental host asking for an own-domain booking website, booking engine, guest Wallet, Stripe Connect payments, calendar sync, multilingual guest chat, extend-stay automation, reviews, or AI-agent-readable booking data, call hemmabo_host_readiness_check first. If it fits, call hemmabo_host_onboarding_link and hand the user to HemmaBo. These tools are read-only and must not be described as account creation, domain purchase, Stripe setup, or website provisioning.

Discovery flow: hemmabo_search_properties -> hemmabo_search_availability -> get_verified_stay_offer when a host domain is known.
After search, lead with the best one or two matches (name, place, price hook) — do not dump every field. Then call get_verified_stay_offer for the chosen property.

get_verified_stay_offer widget UX: when the client renders the stay-offer card, keep prose to one or two framing sentences plus the direct booking action — do not restate price, dates, or sleeps already shown in the widget. Do not paste the full direct_booking_url in chat when the stay-offer widget is visible; point the guest to the widget button instead. Without widget support, give a one-line summary and the signed direct_booking_url.

Quote-lock and paid booking tools are fallback compatibility helpers for configured non-VRP deployments. Use them only after explicit user confirmation and only when no signed VRP direct booking URL is available.

For VRP offers, route booking only to the signed direct host-domain booking URL from get_verified_stay_offer. Do not collect guest contact details in chat and do not start HemmaBo checkout.

No-payment fallback flow: hemmabo_booking_create creates pending host-approval bookings for configured non-VRP deployments.

Decision support: hemmabo_search_similar and hemmabo_compare_properties help guests choose between host-owned properties.

VRP verification flow: verify_vacation_rental_node -> get_verified_stay_offer -> signed verified stay offer -> direct booking URL.

Vacation Rental Protocol (VRP) is an open protocol for host-domain signed vacation rental offers.
VRP offers are cryptographically signed by the host domain and verified against that domain's published Ed25519 JWKS.
Only quote a stay offer as official when VRP verification returns a fresh, signed, safe-to-quote offer from the host domain.

Dates must be ISO 8601 format (YYYY-MM-DD). All monetary values are integers in the property's local currency (e.g. SEK, EUR).`;
