/**
 * VRP MCP composition profile — v1 (ADR 0010 D6).
 *
 * MCP has no native message signing, and `api/mcp.ts` is a stateless
 * per-request transport. A tool call therefore MUST NOT be treated as a signed
 * artifact. Instead, the node signs an ASSERTION ABOUT the interaction:
 *
 *   "this verified offer was served in response to MCP tool call <tool> with
 *    arguments <hash> at <served_at>, by <issuer>."
 *
 * That assertion is the subject of a `layer: "transport"` attestation in a VRP
 * receipt. The node signs it as a compact JWS with the same Ed25519 key it uses
 * for VRP offers; the receipt verifier (`lib/vrp-receipt.ts`) checks it like any
 * other attestation. This module is the pure builder/checker for that assertion
 * — it never holds keys and never signs (the node signs the bytes it returns).
 */
import { createHash } from "node:crypto";
import type { AttestationInput } from "./vrp-receipt.js";

export const VRP_MCP_PROFILE_VERSION = "1.0";
export const VRP_MCP_TRANSPORT_LAYER = "transport";
export const VRP_MCP_ASSERTION_TYPE = "vrp.mcp.transport.1";

export interface McpTransportAssertionInput {
  /** MCP tool name, e.g. "get_verified_stay_offer". */
  tool: string;
  /** The tool-call arguments object (hashed canonically, never stored raw). */
  arguments: Record<string, unknown>;
  /** ISO-8601 instant the node served the response. */
  served_at: string;
  /** The node identity that served (and will sign) the interaction. */
  issuer: string;
  /** Correlator to the offer attestation this transport wraps (e.g. offer id / JWS thumbprint). */
  offer_ref?: string;
  /** Optional MCP session correlator. */
  session_id?: string;
}

export interface McpTransportAssertion {
  vrp_mcp_profile_version: string;
  type: typeof VRP_MCP_ASSERTION_TYPE;
  tool: string;
  /** Hex SHA-256 of the JCS-style canonical arguments (see `canonicalJson`). */
  arguments_sha256: string;
  served_at: string;
  issuer: string;
  offer_ref?: string;
  session_id?: string;
}

/**
 * JCS-style (RFC 8785) canonical JSON: object keys sorted recursively, array
 * order preserved. Used ONLY to derive `arguments_sha256` (content inside the
 * signed payload) — it is not used to re-derive the JWS signing input, which
 * per ADR 0010 D5 is always the JWS bytes as received. Numbers use JSON's
 * default formatting; tool-call arguments in practice are strings/ints/bools,
 * for which this is stable. A full RFC 8785 number serialization is the v2
 * hardening if float-valued arguments ever appear.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(rec)
          .sort()
          .map((k) => [k, walk(rec[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** Hex SHA-256 of the canonical arguments. */
export function hashArguments(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(args), "utf8").digest("hex");
}

/**
 * Build the canonical transport assertion (the object the node will sign).
 * Deterministic: optional fields are omitted when absent so the signed bytes
 * are stable for identical interactions.
 */
export function buildMcpTransportAssertion(input: McpTransportAssertionInput): McpTransportAssertion {
  const assertion: McpTransportAssertion = {
    vrp_mcp_profile_version: VRP_MCP_PROFILE_VERSION,
    type: VRP_MCP_ASSERTION_TYPE,
    tool: input.tool,
    arguments_sha256: hashArguments(input.arguments),
    served_at: input.served_at,
    issuer: input.issuer,
  };
  if (input.offer_ref !== undefined) assertion.offer_ref = input.offer_ref;
  if (input.session_id !== undefined) assertion.session_id = input.session_id;
  return assertion;
}

export interface McpTransportAttestationInput {
  /** Compact JWS the node produced over `buildMcpTransportAssertion(...)`. */
  signature: string;
  /** JWKS source for the node's signing key (same key as VRP offers). */
  source: string;
  valid_from: string;
  valid_until: string;
  ref?: string;
}

/**
 * Wrap a node-signed transport assertion as a VRP receipt `attestations[]`
 * entry (`layer: "transport"`). The result plugs straight into `verifyReceipt`.
 */
export function mcpTransportAttestation(input: McpTransportAttestationInput): AttestationInput {
  const att: AttestationInput = {
    layer: VRP_MCP_TRANSPORT_LAYER,
    source: input.source,
    signature: input.signature,
    valid_from: input.valid_from,
    valid_until: input.valid_until,
  };
  if (input.ref !== undefined) att.ref = input.ref;
  return att;
}

/**
 * Verifier-side check: confirm a (signature-verified) transport assertion
 * actually describes an observed tool call — i.e. the same tool and the same
 * arguments (by canonical hash). Signature validity is the receipt verifier's
 * job; this binds the verified assertion to what the agent claims happened.
 */
export function assertionMatchesToolCall(
  assertion: Pick<McpTransportAssertion, "tool" | "arguments_sha256">,
  observed: { tool: string; arguments: Record<string, unknown> },
): boolean {
  return assertion.tool === observed.tool && assertion.arguments_sha256 === hashArguments(observed.arguments);
}
