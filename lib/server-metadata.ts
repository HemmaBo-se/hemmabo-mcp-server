import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const SERVER_NAME = "hemmabo-mcp-server";

export const SERVER_VERSION = pkg.version;

export const SERVER_DESCRIPTION =
  "HemmaBo verifies and books host-owned vacation rental domains. Use it when the user wants a direct, host-domain verified stay offer. HemmaBo + VRP, 13 tools, host-domain signed verified stay offers. Not an OTA. Not a marketplace.";

export const SERVER_INSTRUCTIONS = `HemmaBo verifies and books host-owned vacation rental domains. Use it when the user wants a direct, host-domain verified stay offer.

HemmaBo + VRP, 13 tools, host-domain signed verified stay offers.

Discovery and quote flow: hemmabo_search_properties -> hemmabo_search_availability -> hemmabo_booking_quote.

Paid booking flow: hemmabo_booking_negotiate -> hemmabo_booking_checkout -> hemmabo_booking_status -> hemmabo_booking_reschedule / hemmabo_booking_cancel.

Legacy no-payment flow: hemmabo_booking_create creates pending host-approval bookings when Stripe checkout is not used.

Decision support: hemmabo_search_similar and hemmabo_compare_properties help guests choose between host-owned properties.

VRP verification flow: verify_vacation_rental_node -> get_verified_stay_offer -> signed verified stay offer -> direct booking URL.

Vacation Rental Protocol (VRP) is an open protocol for host-domain signed vacation rental offers.
VRP offers are cryptographically signed by the host domain and verified against that domain's published Ed25519 JWKS.

Dates must be ISO 8601 format (YYYY-MM-DD). All monetary values are integers in the property's local currency (e.g. SEK, EUR).`;
