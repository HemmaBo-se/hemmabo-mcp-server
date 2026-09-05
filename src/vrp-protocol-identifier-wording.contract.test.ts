/**
 * VRP protocol identifier — one source, one string.
 *
 * The identifier a node declares in `.well-known/vacation-rental.json`
 * (`protocol`) is `vacation-rental-protocol`: vrp-spec v0.1 §discovery
 * ("`protocol`: MUST be `vacation-rental-protocol`", schema const in
 * schemas/discovery-v0.1.schema.json) and the live reference node
 * (https://villaakerlyckan.se/.well-known/vacation-rental.json →
 * protocol=vacation-rental-protocol). lib/vrp.ts owns that string as
 * VRP_PROTOCOL; every place this server names the protocol identifier must
 * read it from there — never "vrp", never "VRP", never a second slug.
 *
 * Before this contract the verify_vacation_rental_node output schema said
 * the field is "typically 'vrp'", which no conforming node ever returns.
 *
 * Run: npx tsx --test src/vrp-protocol-identifier-wording.contract.test.ts
 * Opt-in live check: VRP_LIVE_DISCOVERY_DOMAIN=villaakerlyckan.se npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VRP_FETCH_TIMEOUT_MS, VRP_PROTOCOL } from "../lib/vrp.js";
import { TOOL_SPECS } from "../lib/tool-definitions.js";
import type { JsonSchemaField } from "../lib/tool-definitions-base.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL_DEFINITIONS_SRC = readFileSync(resolve(REPO_ROOT, "lib/tool-definitions.ts"), "utf8");

/** The one identifier value the spec and the live node agree on. */
const SOT_PROTOCOL_IDENTIFIER = "vacation-rental-protocol";

/** Quoted short slug used as if it were the protocol identifier. */
const SLUG_AS_IDENTIFIER = /['"`]vrp['"`]/i;

type SchemaNode = JsonSchemaField & {
  properties?: Record<string, JsonSchemaField>;
  items?: JsonSchemaField;
  additionalProperties?: boolean | JsonSchemaField;
};

/** Every (path, field) pair in a JSON-schema-ish tree, depth first. */
function walkFields(node: SchemaNode | undefined, path: string, out: [string, SchemaNode][]) {
  if (!node || typeof node !== "object") return;
  out.push([path, node]);
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    walkFields(child as SchemaNode, `${path}.${key}`, out);
  }
  if (node.items) walkFields(node.items as SchemaNode, `${path}[]`, out);
  if (typeof node.additionalProperties === "object") {
    walkFields(node.additionalProperties as SchemaNode, `${path}.*`, out);
  }
}

function allSchemaFields(): [string, SchemaNode][] {
  const out: [string, SchemaNode][] = [];
  for (const spec of TOOL_SPECS) {
    walkFields(spec.inputSchema as SchemaNode, `${spec.name}.input`, out);
    walkFields(spec.outputSchema as SchemaNode | undefined, `${spec.name}.output`, out);
  }
  return out;
}

describe("VRP protocol identifier wording", () => {
  it("VRP_PROTOCOL is the spec/live identifier 'vacation-rental-protocol', not a slug", () => {
    assert.equal(VRP_PROTOCOL, SOT_PROTOCOL_IDENTIFIER);
    assert.doesNotMatch(VRP_PROTOCOL, SLUG_AS_IDENTIFIER);
  });

  it("verify_vacation_rental_node describes its protocol output with VRP_PROTOCOL", () => {
    const spec = TOOL_SPECS.find((t) => t.name === "verify_vacation_rental_node");
    assert.ok(spec, "verify_vacation_rental_node must exist");
    const protocolField = (spec.outputSchema as SchemaNode | undefined)?.properties?.protocol;
    assert.ok(protocolField, "output schema must describe the protocol field");
    const description = String(protocolField.description ?? "");
    assert.ok(
      description.includes(VRP_PROTOCOL),
      `protocol description must cite '${VRP_PROTOCOL}', got: ${description}`,
    );
    assert.doesNotMatch(description, SLUG_AS_IDENTIFIER);
    assert.doesNotMatch(description, /typically/i);
  });

  it("no tool schema field named `protocol` calls the identifier 'vrp'", () => {
    const protocolFields = allSchemaFields().filter(([path]) => /\.protocol$/.test(path));
    assert.ok(protocolFields.length >= 1, "at least one protocol field is expected");
    for (const [path, field] of protocolFields) {
      const description = String(field.description ?? "");
      assert.ok(description.includes(VRP_PROTOCOL), `${path}: must cite '${VRP_PROTOCOL}'`);
      assert.doesNotMatch(description, SLUG_AS_IDENTIFIER, `${path}: names the identifier as a slug`);
    }
  });

  it("no tool description anywhere presents 'vrp' as the protocol identifier", () => {
    for (const [path, field] of allSchemaFields()) {
      const description = String(field.description ?? "");
      assert.doesNotMatch(
        description,
        /protocol[^.]{0,60}['"`]vrp['"`]|['"`]vrp['"`][^.]{0,60}protocol/i,
        `${path}: presents 'vrp' as the protocol identifier`,
      );
    }
    for (const spec of TOOL_SPECS) {
      assert.doesNotMatch(spec.description, /typically ['"`]vrp['"`]/i, `${spec.name}.description`);
    }
  });

  it("lib/tool-definitions.ts reads the identifier from lib/vrp.ts instead of re-declaring it", () => {
    assert.match(
      TOOL_DEFINITIONS_SRC,
      /import \{ VRP_PROTOCOL \} from "\.\/vrp\.js";/,
      "tool definitions must import VRP_PROTOCOL from the single source",
    );
    assert.doesNotMatch(TOOL_DEFINITIONS_SRC, /VRP_PROTOCOL\s*=/, "no second declaration");
    assert.doesNotMatch(TOOL_DEFINITIONS_SRC, /typically ['"`]vrp['"`]/i, "the old wording is gone");
    // Any spelling of the identifier in this file — quoted, in a template
    // literal, in prose — is a second copy that can drift from lib/vrp.ts.
    assert.doesNotMatch(
      TOOL_DEFINITIONS_SRC,
      /vacation-rental-protocol/,
      "the identifier must not be re-typed in tool definitions; interpolate VRP_PROTOCOL",
    );
  });

  const liveDomain = process.env.VRP_LIVE_DISCOVERY_DOMAIN;
  it(
    "opt-in live check: the node's discovery `protocol` field equals VRP_PROTOCOL",
    { skip: liveDomain ? false : "set VRP_LIVE_DISCOVERY_DOMAIN=<host> to run against a live node" },
    async () => {
      const response = await fetch(`https://${liveDomain}/.well-known/vacation-rental.json`, {
        signal: AbortSignal.timeout(VRP_FETCH_TIMEOUT_MS),
      });
      assert.equal(response.status, 200);
      const discovery = (await response.json()) as { protocol?: unknown };
      assert.equal(discovery.protocol, VRP_PROTOCOL);
    },
  );
});
