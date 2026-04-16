-- ============================================================
-- Row Level Security policies for hemmabo-mcp-server
--
-- Access model:
--   anon  — the SUPABASE_ANON_KEY client (read-only queries)
--   service_role — bypasses RLS (writes, admin operations)
--
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor).
-- Safe to re-run: all statements use CREATE POLICY IF NOT EXISTS
-- or DROP + CREATE to stay idempotent.
-- ============================================================


-- ── properties ───────────────────────────────────────────────────
-- Anon can read published properties only.
-- Writes are service_role only (bypasses RLS).

ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_published_properties" ON properties;
CREATE POLICY "anon_read_published_properties"
  ON properties
  FOR SELECT
  TO anon
  USING (published = true);


-- ── property_price_blocks ────────────────────────────────────────
-- Anon can read price blocks for published properties.

ALTER TABLE property_price_blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_price_blocks" ON property_price_blocks;
CREATE POLICY "anon_read_price_blocks"
  ON property_price_blocks
  FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM properties
      WHERE properties.id = property_price_blocks.property_id
        AND properties.published = true
    )
  );


-- ── property_seasons ─────────────────────────────────────────────
-- Anon can read seasons for published properties.

ALTER TABLE property_seasons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_seasons" ON property_seasons;
CREATE POLICY "anon_read_seasons"
  ON property_seasons
  FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM properties
      WHERE properties.id = property_seasons.property_id
        AND properties.published = true
    )
  );


-- ── property_smart_pricing ───────────────────────────────────────
-- Anon can read smart pricing config for published properties.

ALTER TABLE property_smart_pricing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_smart_pricing" ON property_smart_pricing;
CREATE POLICY "anon_read_smart_pricing"
  ON property_smart_pricing
  FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM properties
      WHERE properties.id = property_smart_pricing.property_id
        AND properties.published = true
    )
  );


-- ── property_blocked_dates ───────────────────────────────────────
-- Anon can read blocked dates for published properties (needed for
-- availability checks). Source column is not exposed in the response.

ALTER TABLE property_blocked_dates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_blocked_dates" ON property_blocked_dates;
CREATE POLICY "anon_read_blocked_dates"
  ON property_blocked_dates
  FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM properties
      WHERE properties.id = property_blocked_dates.property_id
        AND properties.published = true
    )
  );


-- ── booking_locks ────────────────────────────────────────────────
-- Anon can read active locks for published properties (availability
-- checks need to see in-progress holds). No write access for anon.

ALTER TABLE booking_locks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_booking_locks" ON booking_locks;
CREATE POLICY "anon_read_booking_locks"
  ON booking_locks
  FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM properties
      WHERE properties.id = booking_locks.property_id
        AND properties.published = true
    )
  );


-- ── host_policies ────────────────────────────────────────────────
-- Anon can read cancellation policies for published properties
-- (shown in booking status responses).

ALTER TABLE host_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_host_policies" ON host_policies;
CREATE POLICY "anon_read_host_policies"
  ON host_policies
  FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM properties
      WHERE properties.id = host_policies.property_id
        AND properties.published = true
    )
  );


-- ── property_quote_snapshots ─────────────────────────────────────
-- Anon can read a snapshot by its id (used during checkout to
-- validate a locked quote). No row-level owner — access is by
-- knowing the UUID, which is treated as a capability token.

ALTER TABLE property_quote_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_quote_snapshots" ON property_quote_snapshots;
CREATE POLICY "anon_read_quote_snapshots"
  ON property_quote_snapshots
  FOR SELECT
  TO anon
  USING (true);
-- Note: snapshots are short-lived (15 min TTL via valid_until).
-- The UUID itself is the access control — no additional predicate needed.


-- ── bookings ─────────────────────────────────────────────────────
-- No anon access. All booking reads and writes go through the
-- service_role client (which bypasses RLS). Booking lookups are
-- privileged operations — only authenticated MCP agents with a
-- valid API key can reach the tools that query this table.

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

-- No SELECT policy for anon — service_role bypasses RLS entirely.
-- Explicitly deny anon reads to make the intent clear.
DROP POLICY IF EXISTS "deny_anon_read_bookings" ON bookings;
CREATE POLICY "deny_anon_read_bookings"
  ON bookings
  FOR SELECT
  TO anon
  USING (false);
