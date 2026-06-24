/**
 * Open VRP receipt verifier — standalone CLI (ADR 0010 Phase 4).
 *
 * Anyone can verify a receipt against a JWKS, with no HemmaBo dependency:
 *
 *   # a self-contained test vector ({ jwks, receipt, now }):
 *   npx tsx scripts/verify-receipt.ts spec/vectors/01-offer-transport-verified.json
 *
 *   # a receipt + separate JWKS file:
 *   npx tsx scripts/verify-receipt.ts ./receipt.json ./jwks.json
 *
 * Prints the per-attestation verification result as JSON. Exit code: 0 when the
 * receipt is structurally valid AND fully verified, 2 when valid but only
 * partially verified, 1 when invalid or on usage error.
 *
 * In this reference CLI the JWKS is supplied directly; a production verifier
 * would resolve each attestation's `source` (e.g. fetch the issuer JWKS).
 */
import { readFileSync } from "node:fs";
import { verifyReceipt, type JwksResolver } from "../lib/vrp-receipt.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [inputPath, jwksPath] = process.argv.slice(2);
if (!inputPath) fail("usage: verify-receipt.ts <vector-or-receipt.json> [jwks.json]");

let parsed: Record<string, unknown>;
try {
  parsed = JSON.parse(readFileSync(inputPath, "utf8"));
} catch (e) {
  fail(`could not read/parse ${inputPath}: ${e instanceof Error ? e.message : String(e)}`);
}

const isVector = parsed.receipt !== undefined && parsed.jwks !== undefined;
const receipt = isVector ? parsed.receipt : parsed;
let jwks: Record<string, unknown> | null = isVector ? (parsed.jwks as Record<string, unknown>) : null;
if (!jwks) {
  if (!jwksPath) fail("a plain receipt requires a second argument: the JWKS file");
  try {
    jwks = JSON.parse(readFileSync(jwksPath, "utf8"));
  } catch (e) {
    fail(`could not read/parse ${jwksPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const now = typeof parsed.now === "string" ? Date.parse(parsed.now) : Date.now();
const resolveJwks: JwksResolver = () => jwks;
const result = verifyReceipt(receipt, { resolveJwks, now });

console.log(JSON.stringify(result, null, 2));
process.exit(!result.receipt_valid ? 1 : result.fully_verified ? 0 : 2);
