# Security Policy

## Reporting a Vulnerability

If you believe you have found a security vulnerability in this repository or in
the hosted MCP endpoint (`https://www.hemmabo.com/mcp`), please report it
privately by email:

**info@hemmabo.se** — use a subject line starting with `SECURITY:`.

Please include:

- a description of the issue and its potential impact,
- steps to reproduce (a proof of concept helps, but is not required),
- the affected endpoint, tool, or file if known.

Please do **not** open a public GitHub issue for security reports, and do not
test against live host bookings or real guest data.

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
