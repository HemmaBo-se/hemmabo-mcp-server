-- Migration: add refund tracking columns to bookings (#70)
--
-- ADR 0002 §2.2 clause 4 (no silent payment failures) and clause 5 (refund
-- completion before status flip) require that refund attempts are recorded
-- on the booking row itself, not just inferred from a Stripe API response
-- that may already be lost.
--
-- Three new columns:
--   refund_status   — 'none' | 'pending' | 'succeeded' | 'failed'
--                     authoritative state written by the Stripe webhook
--                     (charge.refunded → succeeded, charge.refund.failed →
--                     failed). The synchronous cancel handler may write
--                     'pending'; it must NEVER write 'succeeded' on its own.
--   refund_id       — Stripe refund object id (re_...). Null until Stripe
--                     issues one. Useful for audit + customer support.
--   refund_error    — Stripe error code string (e.g. 'charge_already_refunded',
--                     'expired_refund_window'). Null on success. Populated by
--                     the synchronous handler on 4xx from /v1/refunds and by
--                     the webhook on charge.refund.failed.
--
-- Run order: this migration must be applied BEFORE deploying the code
-- changes in PR for #70. Vercel will roll back the deploy if the column
-- is missing because the webhook handler writes it on every refund event.
--
-- Reversible: yes. The DROP COLUMN statements at the bottom (commented
-- out) restore the original schema.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS refund_status text
    NOT NULL DEFAULT 'none'
    CHECK (refund_status IN ('none', 'pending', 'succeeded', 'failed'));

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS refund_id text;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS refund_error text;

-- Index for support queries: "show all bookings with a failed refund".
CREATE INDEX IF NOT EXISTS bookings_refund_failed_idx
  ON bookings (refund_status)
  WHERE refund_status = 'failed';

-- ── Rollback (DO NOT RUN unless reverting the #70 deploy) ────────────
-- DROP INDEX IF EXISTS bookings_refund_failed_idx;
-- ALTER TABLE bookings DROP COLUMN IF EXISTS refund_error;
-- ALTER TABLE bookings DROP COLUMN IF EXISTS refund_id;
-- ALTER TABLE bookings DROP COLUMN IF EXISTS refund_status;
