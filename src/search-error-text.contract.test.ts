/**
 * Contract: when the properties query fails, hemmabo_search_properties tells
 * the caller one plain sentence and keeps the database's own error text in
 * the log.
 *
 * Hole this pins shut (7.0.2): the tool relayed Supabase's `error.message` to
 * the caller. That text is PostgREST's or Postgres' own ("relation
 * \"properties\" does not exist", "column properties.x does not exist") or a
 * raw gateway body, and the caller is anonymous in open mode.
 *
 * Run: npx tsx --test src/search-error-text.contract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../lib/tools.js";
import type { ToolClients } from "../lib/tools-base.js";

const DB_MESSAGE = 'relation "properties" does not exist';
const PLAIN_SENTENCE = "Property search is temporarily unavailable. Try again shortly.";

/** A reader whose `properties` query resolves to a Supabase-shaped error. */
function failingClients(): ToolClients {
  const query: any = {
    select: () => query,
    eq: () => query,
    gte: () => query,
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: null, error: { message: DB_MESSAGE, code: "42P01" } }).then(resolve),
  };
  const client = { from: () => query } as any;
  return { supabase: client, reader: client } as ToolClients;
}

describe("hemmabo_search_properties on a database error", () => {
  it("answers isError with the plain sentence and never the database's text", async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); };
    try {
      const result = await executeTool(
        "hemmabo_search_properties",
        { guests: 2, checkIn: "2027-06-01", checkOut: "2027-06-05" },
        failingClients(),
      );
      assert.equal(result.isError, true);
      const text = result.content[0]?.text ?? "";
      assert.equal(JSON.parse(text).error, PLAIN_SENTENCE);
      assert.ok(!text.includes(DB_MESSAGE), "the database's error text must not reach the caller");
      assert.ok(!text.includes("properties"), "no table name in the caller's text");
      assert.ok(
        logged.some((line) => line.includes(DB_MESSAGE)),
        "the database's error text goes to the log",
      );
    } finally {
      console.error = original;
    }
  });
});
