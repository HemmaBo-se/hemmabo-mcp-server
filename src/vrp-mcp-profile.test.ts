import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import {
  buildMcpTransportAssertion,
  mcpTransportAttestation,
  hashArguments,
  canonicalJson,
  assertionMatchesToolCall,
  VRP_MCP_ASSERTION_TYPE,
  VRP_MCP_TRANSPORT_LAYER,
} from "../lib/vrp-mcp-profile.js";
import { verifyReceipt, VRP_RECEIPT_VERSION, type JwksResolver } from "../lib/vrp-receipt.js";

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KID = "vrp-mcp-test-2026-06-24-01";
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID, alg: "EdDSA", use: "sig" };
const JWKS = { keys: [jwk] };
const resolveOk: JwksResolver = () => JWKS;

function signJws(payload: Record<string, unknown>, key: KeyObject = privateKey): string {
  const header = { alg: "EdDSA", kid: KID, typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(edSign(null, Buffer.from(signingInput), key))}`;
}

const HOUR = 3_600_000;
const servedAt = new Date().toISOString();
const callArgs = { domain: "villaakerlyckan.se", checkIn: "2026-09-02", checkOut: "2026-09-05", guests: 4 };

test("MCP profile: assertion is deterministic and omits absent optional fields", () => {
  const a = buildMcpTransportAssertion({
    tool: "get_verified_stay_offer",
    arguments: callArgs,
    served_at: servedAt,
    issuer: "villaakerlyckan.se",
  });
  assert.equal(a.type, VRP_MCP_ASSERTION_TYPE);
  assert.equal(a.tool, "get_verified_stay_offer");
  assert.equal("offer_ref" in a, false);
  assert.equal("session_id" in a, false);
  assert.deepEqual(a, buildMcpTransportAssertion({
    tool: "get_verified_stay_offer",
    arguments: { ...callArgs },
    served_at: servedAt,
    issuer: "villaakerlyckan.se",
  }));
});

test("MCP profile: arguments hash is stable regardless of key order (JCS-style)", () => {
  const reordered = { guests: 4, checkOut: "2026-09-05", checkIn: "2026-09-02", domain: "villaakerlyckan.se" };
  assert.equal(hashArguments(callArgs), hashArguments(reordered));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("MCP profile: a changed argument changes the hash", () => {
  assert.notEqual(hashArguments(callArgs), hashArguments({ ...callArgs, guests: 5 }));
});

test("MCP profile: assertionMatchesToolCall binds a verified assertion to an observed call", () => {
  const a = buildMcpTransportAssertion({
    tool: "get_verified_stay_offer",
    arguments: callArgs,
    served_at: servedAt,
    issuer: "villaakerlyckan.se",
  });
  assert.equal(assertionMatchesToolCall(a, { tool: "get_verified_stay_offer", arguments: { ...callArgs } }), true);
  assert.equal(assertionMatchesToolCall(a, { tool: "get_verified_stay_offer", arguments: { ...callArgs, guests: 5 } }), false);
  assert.equal(assertionMatchesToolCall(a, { tool: "verify_vacation_rental_node", arguments: callArgs }), false);
});

test("MCP profile: a node-signed transport attestation verifies inside a receipt (D6 → D1–D5)", () => {
  const assertion = buildMcpTransportAssertion({
    tool: "get_verified_stay_offer",
    arguments: callArgs,
    served_at: servedAt,
    issuer: "villaakerlyckan.se",
    offer_ref: "offer:villaakerlyckan.se:2026-09-02/05",
  });
  const transport = mcpTransportAttestation({
    signature: signJws(assertion as unknown as Record<string, unknown>),
    source: "https://villaakerlyckan.se/.well-known/jwks.json",
    valid_from: new Date(Date.now() - HOUR).toISOString(),
    valid_until: new Date(Date.now() + HOUR).toISOString(),
    ref: assertion.offer_ref,
  });
  const offer = {
    layer: "offer",
    source: "https://villaakerlyckan.se/.well-known/jwks.json",
    signature: signJws({ offer_id: "offer:villaakerlyckan.se:2026-09-02/05" }),
    ref: "offer:villaakerlyckan.se:2026-09-02/05",
    valid_from: new Date(Date.now() - HOUR).toISOString(),
    valid_until: new Date(Date.now() + HOUR).toISOString(),
  };
  const receipt = {
    vrp_receipt_version: VRP_RECEIPT_VERSION,
    subject: { property: "villaakerlyckan.se" },
    issuer: { node: "villaakerlyckan.se" },
    attestations: [offer, transport],
  };
  const r = verifyReceipt(receipt, { resolveJwks: resolveOk });
  assert.equal(r.receipt_valid, true);
  assert.equal(r.fully_verified, true);
  assert.equal(r.attestations[1].layer, VRP_MCP_TRANSPORT_LAYER);
  assert.deepEqual(r.attestations.map((a) => a.status), ["verified", "verified"]);
});

test("MCP profile: tampering the signed assertion fails transport verification", () => {
  const assertion = buildMcpTransportAssertion({
    tool: "get_verified_stay_offer",
    arguments: callArgs,
    served_at: servedAt,
    issuer: "villaakerlyckan.se",
  });
  const sig = signJws(assertion as unknown as Record<string, unknown>);
  const transport = mcpTransportAttestation({
    signature: `${sig.slice(0, -4)}AAAA`,
    source: "https://villaakerlyckan.se/.well-known/jwks.json",
    valid_from: new Date(Date.now() - HOUR).toISOString(),
    valid_until: new Date(Date.now() + HOUR).toISOString(),
  });
  const r = verifyReceipt(
    {
      vrp_receipt_version: VRP_RECEIPT_VERSION,
      subject: {},
      issuer: {},
      attestations: [transport],
    },
    { resolveJwks: resolveOk },
  );
  assert.equal(r.attestations[0].status, "invalid");
  assert.equal(r.attestations[0].error, "sig_invalid");
});
