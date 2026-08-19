# ADR 0015: Availability buffer parity with the host node's truth path

- Status: Accepted
- Date: 2026-08-19

## Context

This server carried the third independent implementation of the calendar
logic. The host node's truth path (`hemmabo-smart-stays`
`api/_lib/availability-truth.ts`) expands bookings and channel-manager
blocked-date rows (`source='channex'`) by the property's turnaround buffer
(`properties.buffer_nights_before/after`; smart-stays decision 2026-08-12),
keeps manual and legacy-iCal blocks exact (smart-stays ADR 2026-06-24
mirror-exact), and never buffers `booking_locks`. This server compared all
rows raw, and its alternative-window scan ignored `min_nights`.

Consequence (SoT audit 2026-08-18, live case villaakerlyckan.se): a channex
stay [2026-09-08, 2026-09-10) with buffer 1/1 blocks the night of 09-07 on
the node, yet `hemmabo_search_availability` answered available for
09-05→09-08 and the gap-scan offered 1-night windows the node refuses with
`min_nights_violation`. The MCP surface promised what the node denied.
The node's search layer got the same fix in smart-stays PR #2660.

## Decision

1. **Vendored shared core.** `lib/availability-core.ts` is a byte-identical
   vendored mirror of smart-stays `contracts/ts/availability-core.ts` (same
   law as `lib/pricing-core.ts`; smart-stays ADR
   2026-05-01-availability-truth-shared-core). The wrapper
   `lib/availability.ts` imports its date/overlap/buffer helpers from the
   core and redeclares nothing. Guarded by
   `src/availability-core-vendored.contract.test.ts`.
2. **Buffer semantics.** `checkAvailability` and `findFreeWindowsInMonth`
   expand bookings and channex blocks by the property's buffer; manual and
   legacy-iCal blocks stay exact; locks are never buffered. Fetch windows
   are widened by the buffer so buffered spans are seen; the in-memory
   overlap check decides.
3. **Buffer source.** Callers that already hold the property row pass
   buffers in (`hemmabo_search_properties`); everywhere else the resolver
   reads `properties` itself. The read is fail-closed: an errored read
   answers unavailable / no windows, never a silent buffer-less comparison.
4. **min_nights floor.** The gap-scan never emits a window shorter than the
   host's `min_nights` — an alternative we offer must be bookable by
   construction.

## Consequences

- Tool answers match the node's booking engine for buffered calendars;
  `available: true` from this server can no longer collide with a
  `host_blocked` refusal at booking time.
- One extra `properties` read per availability check on paths that do not
  already hold the row (booking create/checkout/reschedule, ACP) — bounded
  and rare compared to the existing per-check query fan-out.
- Guarded by `src/availability-buffer-parity.contract.test.ts` (live-case
  fixtures) and the vendored-core contract. Changes to buffering rules land
  in smart-stays `contracts/ts/availability-core.ts` first and are
  re-vendored here — never edited locally.
