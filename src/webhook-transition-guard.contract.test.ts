/**
 * Contract test (D) — payment_intent.succeeded transition guard.
 *
 * The webhook is the authoritative Stripe-event reconciler (ADR 0006), but
 * Stripe delivers events at-least-once and can deliver them late. A succeeded
 * event must NOT resurrect a booking that is already cancelled (or any other
 * non-pending / terminal state) back to confirmed. Only a still-pending booking
 * may be confirmed by this event; anything else is refused, fail-closed, with a
 * structured log for ops reconciliation.
 *
 * handleEvent is exported with an injectable-deps seam so it runs against a mock
 * Supabase client (the handler otherwise constructs its own from env).
 *
 * Run: npx tsx --test src/webhook-transition-guard.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleEvent } from "../api/stripe-webhook.js";

// Mock Supabase: SELECT status via .maybeSingle(); UPDATE recorded on await.
function makeSupabase(currentStatus: string | null) {
  const updates: Array<Record<string, unknown>> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (): any => {
    let isUpdate = false;
    let payload: Record<string, unknown> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      update: (p: Record<string, unknown>) => { isUpdate = true; payload = p; return chain; },
      eq: () => chain,
      maybeSingle: () =>
        Promise.resolve(currentStatus === null ? { data: null, error: null } : { data: { status: currentStatus }, error: null }),
      then: (r: (v: unknown) => unknown) => {
        if (isUpdate && payload) updates.push(payload);
        return Promise.resolve({ error: null }).then(r);
      },
    };
    return chain;
  };
  return { supabase: { from } as never, updates };
}

function succeededEvent(bookingId: string | undefined = "b-1", piId = "pi_x") {
  return {
    id: "evt_1",
    type: "payment_intent.succeeded",
    data: { object: { id: piId, metadata: bookingId ? { booking_id: bookingId } : undefined } },
  };
}

// Capture console.warn for the structured-log assertions.
function withWarnCapture<T>(fn: (warns: string[]) => Promise<T>): Promise<T> {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
  return fn(warns).finally(() => { console.warn = original; });
}

describe("payment_intent.succeeded transition guard (D)", () => {
  it("pending → confirmed (the happy path), persisting the PaymentIntent id", async () => {
    const { supabase, updates } = makeSupabase("pending");
    const res = await handleEvent(succeededEvent(), { supabase });
    assert.deepEqual(res, { status: "ok" });
    assert.equal(updates.length, 1, "exactly one confirm write");
    assert.equal(updates[0].status, "confirmed");
    assert.equal(updates[0].stripe_payment_intent_id, "pi_x");
  });

  it("cancelled → stays cancelled: no confirm write, structured log", async () => {
    await withWarnCapture(async (warns) => {
      const { supabase, updates } = makeSupabase("cancelled");
      const res = await handleEvent(succeededEvent(), { supabase });
      assert.equal(res.status, "ignored");
      assert.match(res.detail ?? "", /cancelled/);
      assert.equal(updates.length, 0, "a cancelled booking must NOT be resurrected to confirmed");
      assert.ok(
        warns.some((w) => w.includes("webhook_succeeded_on_non_confirmable_booking") && w.includes("cancelled") && w.includes("pi_x")),
        `expected a structured anomaly log, got: ${warns.join(" | ")}`,
      );
    });
  });

  it("already confirmed → idempotent no-op (redelivery), no second write", async () => {
    const { supabase, updates } = makeSupabase("confirmed");
    const res = await handleEvent(succeededEvent(), { supabase });
    assert.equal(res.status, "ok");
    assert.match(res.detail ?? "", /already confirmed/);
    assert.equal(updates.length, 0);
  });

  it("other terminal state (e.g. 'completed') → refused + logged, not confirmed", async () => {
    await withWarnCapture(async (warns) => {
      const { supabase, updates } = makeSupabase("completed");
      const res = await handleEvent(succeededEvent(), { supabase });
      assert.equal(res.status, "ignored");
      assert.equal(updates.length, 0);
      assert.ok(warns.some((w) => w.includes("completed")), "must log the non-confirmable anomaly");
    });
  });

  it("no booking row for the id → ignored, no write", async () => {
    const { supabase, updates } = makeSupabase(null);
    const res = await handleEvent(succeededEvent(), { supabase });
    assert.equal(res.status, "ignored");
    assert.match(res.detail ?? "", /no booking row/);
    assert.equal(updates.length, 0);
  });

  it("missing booking_id metadata → ignored before any DB read", async () => {
    const { supabase, updates } = makeSupabase("pending");
    // Event with no metadata at all (built inline so no default booking_id sneaks in).
    const res = await handleEvent(
      { id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: "pi_x" } } },
      { supabase },
    );
    assert.equal(res.status, "ignored");
    assert.match(res.detail ?? "", /no booking_id/);
    assert.equal(updates.length, 0);
  });
});
