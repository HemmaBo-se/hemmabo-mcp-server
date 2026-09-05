# Security Policy

## Reporting a Vulnerability

If you believe you have found a security vulnerability in this repository or in
the hosted MCP endpoint (`https://www.hemmabo.com/mcp`), please report it
privately — do **not** open a public GitHub issue.

- **Preferred:** GitHub **[Report a vulnerability](https://github.com/HemmaBo-se/hemmabo-mcp-server/security/advisories/new)**
  (Security → Advisories → Report a vulnerability). This opens a private advisory
  visible only to you and the maintainers.
- **Alternative:** email **info@hemmabo.se** with a subject line starting with
  `SECURITY:`.

Please include:

- a description of the issue and its potential impact,
- steps to reproduce (a proof of concept helps, but is not required),
- the affected endpoint, tool, or file if known.

Do not test against live host bookings or real guest data.

Protocol-level issues in Vacation Rental Protocol (spec text, schemas,
conformance vectors, signing rules) belong in
[`vacationrentalprotocol/vrp-spec`](https://github.com/vacationrentalprotocol/vrp-spec/security/advisories/new),
not here.

## What to Expect

- We aim to acknowledge your report within 5 business days.
- We will keep you informed as we investigate and remediate.
- We ask that you give us reasonable time to fix the issue before any public
  disclosure (coordinated disclosure).

We do not currently run a paid bug bounty program, but we credit reporters in
release notes on request.

## Scope

- This repository (the HemmaBo MCP server reference implementation).
- The hosted endpoint `https://www.hemmabo.com/mcp` and its
  `/.well-known/*` discovery surfaces.

Issues in the HemmaBo platform or on individual host domains can be reported to
the same address; we will route them to the right place.
