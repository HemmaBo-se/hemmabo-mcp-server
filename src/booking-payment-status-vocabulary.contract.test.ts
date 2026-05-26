import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const ACP_PROTOCOL_STATUSES = [
  "not_ready_for_payment",
  "ready_for_payment",
  "completed",
  "canceled",
  "in_progress",
] as const;

const MCP_COMPAT_BOOKING_STATUS_ENUM = [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
] as const;

const STRIPE_WEBHOOK_EVENTS = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.refund.updated",
] as const;

const REFUND_STATUS_SCHEMA_VALUES = [
  "none",
  "pending",
  "succeeded",
  "failed",
] as const;

const TRACKED_STATUS_WORDS = [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
  "declined",
  "paid",
  "checked_in",
  "checked_out",
  "disputed",
  "refund_status",
  "none",
  "succeeded",
  "failed",
] as const;

const FORBIDDEN_DIRECT_BOOKINGS_STATUS_WRITES = [
  "completed",
  "paid",
  "disputed",
  "checked_in",
  "checked_out",
] as const;

const CONFIRMED_OWNERSHIP_ADR = "docs/adr/0006-confirmed-status-ownership.md";

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function sameMembers(actual: Iterable<string>, expected: readonly string[]) {
  assert.deepEqual([...new Set(actual)].sort(), [...expected].sort());
}

function quotedStrings(source: string): string[] {
  return [...source.matchAll(/["']([a-z_.]+)["']/g)].map((match) => match[1]);
}

function sectionFrom(source: string, marker: string, length = 2_000): string {
  const index = source.indexOf(marker);
  assert.ok(index >= 0, `Could not find marker: ${marker}`);
  return source.slice(index, index + length);
}

function walkFiles(relativeDir: string, extensions: readonly string[]): string[] {
  const dir = join(root, relativeDir);
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const relativePath = `${relativeDir}/${entry}`;
    const fullPath = join(root, relativePath);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (entry !== "node_modules") {
        files.push(...walkFiles(relativePath, extensions));
      }
      continue;
    }

    if (extensions.some((extension) => relativePath.endsWith(extension))) {
      files.push(relativePath);
    }
  }

  return files;
}

function directBookingsStatusWrites(statuses: readonly string[]): string[] {
  const statusAlternation = statuses.join("|");
  const writePattern = new RegExp(
    String.raw`\.from\(["']bookings["']\)[\s\S]{0,1500}\.(insert|update|upsert)\([\s\S]{0,600}status:\s*["'](${statusAlternation})["']`,
    "m",
  );

  return [
    ...walkFiles("api", [".ts", ".js"]),
    ...walkFiles("lib", [".ts", ".js"]),
    ...walkFiles("src", [".ts", ".js"]),
  ].flatMap((path) => {
    const match = readRepoFile(path).match(writePattern);
    return match ? [`${path}:${match[2]}`] : [];
  });
}

describe("MCP booking/payment status vocabulary contract", () => {
  it("keeps ACP protocol statuses separate from bookings.status", () => {
    const source = readRepoFile("api/acp.ts");
    const interfaceBlock = sectionFrom(source, "interface ACPCheckoutState", 600);
    const statusUnion = interfaceBlock.match(/status:\s*([^;]+);/)?.[1];

    assert.ok(statusUnion, "ACPCheckoutState.status union must stay reviewable");
    sameMembers(quotedStrings(statusUnion), ACP_PROTOCOL_STATUSES);
  });

  it("snapshots ACP direct bookings.status writes", () => {
    const source = readRepoFile("api/acp.ts");

    assert.match(
      source,
      /\.from\("bookings"\)\s*\.insert\(\{[\s\S]*?status:\s*"pending"/,
      "ACP createCheckout must keep creating bookings as pending.",
    );
    assert.match(
      source,
      /\/\/ Update booking to confirmed[\s\S]*?\.from\("bookings"\)\s*\.update\(\{[\s\S]*?status:\s*"confirmed"/,
      "ACP completeCheckout currently writes confirmed synchronously; changing that requires an ADR.",
    );
    assert.match(
      source,
      /\.from\("bookings"\)\s*\.update\(\{\s*status:\s*"cancelled"\s*\}\)/,
      "ACP cancelCheckout currently writes cancelled; changing that requires an ADR.",
    );
  });

  it("snapshots Stripe webhook event and status writes", () => {
    const source = readRepoFile("api/stripe-webhook.ts");
    const cases = [...source.matchAll(/case\s+"([^"]+)":/g)].map((match) => match[1]);

    sameMembers(cases, STRIPE_WEBHOOK_EVENTS);
    assert.doesNotMatch(
      source,
      /case\s+["']charge\.dispute\.created["']/,
      "Do not implement charge.dispute.created as a HemmaBo-owned dispute flow.",
    );

    assert.match(source, /\.update\(\{\s*status:\s*"confirmed"/);
    assert.match(source, /\.update\(\{\s*status:\s*"cancelled"/);
    assert.match(source, /refund_status:\s*"succeeded"/);
    assert.match(source, /refund_status:\s*"failed"/);
  });

  it("snapshots bookings refund status schema separately from booking lifecycle", () => {
    const migration = readRepoFile("supabase/migrations/2026-05-12-bookings-refund-status.sql");
    const acp = readRepoFile("api/acp.ts");
    const webhook = readRepoFile("api/stripe-webhook.ts");
    const adr0002 = readRepoFile("docs/adr/0002-auth-payments-and-privacy-contracts.md");
    const adr0005 = readRepoFile("docs/adr/0005-booking-payment-status-vocabulary.md");

    const checkValues = migration.match(/CHECK \(refund_status IN \(([^)]+)\)\)/)?.[1];
    assert.ok(checkValues, "refund_status schema values must stay reviewable.");
    sameMembers(quotedStrings(checkValues), REFUND_STATUS_SCHEMA_VALUES);

    assert.match(migration, /ADD COLUMN IF NOT EXISTS refund_id text/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS refund_error text/);

    assert.match(acp, /refund_status:\s*"pending"/);
    assert.match(acp, /refund_status:\s*"failed"/);
    assert.doesNotMatch(acp, /refund_status:\s*"succeeded"/);
    assert.match(webhook, /refund_status:\s*"succeeded"/);
    assert.match(webhook, /refund_status:\s*"failed"/);

    assert.match(adr0002, /refund_status = failed/);
    assert.doesNotMatch(adr0002, /refund_failed/);
    for (const status of REFUND_STATUS_SCHEMA_VALUES) {
      assert.match(adr0005, new RegExp(`\\\`${status}\\\``));
    }
  });

  it("snapshots public MCP booking status output enums", () => {
    const source = readRepoFile("lib/tool-definitions-base.ts");
    const enums = [...source.matchAll(/status:\s*\{\s*type:\s*"string",\s*enum:\s*\[([^\]]+)\]/g)]
      .map((match) => quotedStrings(match[1]));

    assert.deepEqual(enums, [
      [...MCP_COMPAT_BOOKING_STATUS_ENUM],
      ["cancelled"],
      [...MCP_COMPAT_BOOKING_STATUS_ENUM],
    ]);

    const bookingCreateStatus = sectionFrom(source, 'name: "hemmabo_booking_create"', 2_500);
    const bookingStatusStatus = sectionFrom(source, 'name: "hemmabo_booking_status"', 2_500);
    const rescheduleTool = sectionFrom(source, 'name: "hemmabo_booking_reschedule"', 1_000);

    for (const schemaSection of [bookingCreateStatus, bookingStatusStatus]) {
      assert.match(schemaSection, /completed/);
      assert.match(schemaSection, /legacy\/protocol compatibility output only/);
      assert.doesNotMatch(schemaSection, /completed[^.]+host-node booking lifecycle truth/i);
    }

    assert.match(rescheduleTool, /legacy\/protocol client reports completed/);
  });

  it("snapshots MCP runtime booking write and reschedule vocabulary", () => {
    const source = readRepoFile("lib/tools-base.ts");
    const insertPendingWrites = [...source.matchAll(/\.from\("bookings"\)\s*\.insert\(\{[\s\S]*?status:\s*"pending"/g)];
    const reschedulableStates = source.match(/const RESCHEDULABLE_STATES = \[([^\]]+)\]/)?.[1];

    assert.equal(insertPendingWrites.length, 2, "MCP runtime currently has two pending booking insert paths.");
    assert.match(source, /status:\s*"cancelled"/, "MCP cancel response currently returns cancelled.");
    assert.ok(reschedulableStates, "Reschedulable state list must stay reviewable.");
    sameMembers(quotedStrings(reschedulableStates), ["confirmed", "pending"]);
  });

  it("prevents payment, stay, dispute, and compatibility words from direct bookings.status writes", () => {
    assert.deepEqual(directBookingsStatusWrites(FORBIDDEN_DIRECT_BOOKINGS_STATUS_WRITES), []);
  });

  it("keeps ADR 0005 tied to every tracked status word", () => {
    const source = readRepoFile("docs/adr/0005-booking-payment-status-vocabulary.md");

    for (const status of TRACKED_STATUS_WORDS) {
      assert.match(source, new RegExp(`\\\`${status}\\\``));
    }

    assert.match(source, /Hosts handle\s+Stripe chargebacks in Stripe Dashboard/);
    assert.match(source, /must stay unclaimed by HemmaBo/);
    assert.match(source, /outside HemmaBo-owned handling/);
    assert.match(source, /accepted chargeback-boundary ADR/);
    assert.match(source, /must not introduce a HemmaBo-owned dispute workflow/);
    assert.match(source, /`completed` remains a public MCP compatibility output value only/);
    assert.match(source, /not a host-node booking lifecycle status/);
    assert.doesNotMatch(source, /known gap/);
    assert.doesNotMatch(source, /payment\/dispute schema\s+contract exists for dispute handling/);
    assert.doesNotMatch(source, /schema\/status contract/);
  });

  it("keeps Stripe chargebacks host-owned, not HemmaBo-owned", () => {
    const webhook = readRepoFile("api/stripe-webhook.ts");
    const adr0005 = readRepoFile("docs/adr/0005-booking-payment-status-vocabulary.md");
    const adr0006 = readRepoFile(CONFIRMED_OWNERSHIP_ADR);
    const runtimeAndSchemaFiles = [
      ...walkFiles("api", [".ts", ".js"]),
      ...walkFiles("lib", [".ts", ".js"]),
      ...walkFiles("supabase", [".sql"]),
    ];

    for (const source of [webhook, adr0005, adr0006]) {
      assert.match(source, /Stripe chargebacks[\s\S]*host|host operates Stripe chargebacks|Hosts handle Stripe\s+chargebacks[\s\S]*Stripe Dashboard/i);
      assert.doesNotMatch(source, /bookings\.status\s*=\s*["'`]?disputed/);
      assert.doesNotMatch(source, /payment_disputes|stripe_disputes/);
    }

    for (const path of runtimeAndSchemaFiles) {
      assert.doesNotMatch(readRepoFile(path), /payment_disputes|stripe_disputes/, `${path} must not introduce HemmaBo-owned Stripe dispute storage.`);
    }
  });

  it("locks confirmed ownership wording to current code without OTA ownership", () => {
    const acp = readRepoFile("api/acp.ts");
    const webhook = readRepoFile("api/stripe-webhook.ts");
    const adr0002 = readRepoFile("docs/adr/0002-auth-payments-and-privacy-contracts.md");
    const adr0005 = readRepoFile("docs/adr/0005-booking-payment-status-vocabulary.md");
    const adr0006 = readRepoFile(CONFIRMED_OWNERSHIP_ADR);

    assert.match(
      acp,
      /\/\/ Update booking to confirmed[\s\S]*?\.from\("bookings"\)\s*\.update\(\{[\s\S]*?status:\s*"confirmed"/,
    );
    assert.match(
      webhook,
      /case "payment_intent\.succeeded":[\s\S]*?\.update\(\{\s*status:\s*"confirmed"/,
    );

    assert.doesNotMatch(
      adr0002,
      /single writer of `?bookings\.status = confirmed/i,
      "ADR 0002 must not keep claiming webhook-only confirmed ownership after ADR 0006.",
    );
    assert.match(adr0005, /ADR 0006 locks this current behavior/);

    for (const requiredLine of [
      "HemmaBo is infrastructure and federation, not an OTA or marketplace.",
      "The host node owns the booking lifecycle.",
      "Stripe owns payment event facts.",
      "`refund_status`",
      "Do not introduce `paid`, `disputed`, or refund-state words as",
      "adds a payment/refund/dispute word such as",
      "Hosts handle Stripe",
      "HemmaBo-owned dispute workflow",
      "No runtime behavior changes are made by this ADR.",
      "ADR 0002's webhook-only terminal-status clause is superseded for",
      "This does not make HemmaBo an OTA, marketplace",
      "Do not introduce",
    ]) {
      assert.match(adr0006, new RegExp(requiredLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});
