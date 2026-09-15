import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isDcrRedirectHostAllowed,
  isDisabledClientId,
} from "../lib/oauth-dcr-policy.js";

describe("oauth-dcr-policy", () => {
  it("allows Claude and loopback redirects", () => {
    assert.equal(isDcrRedirectHostAllowed("https://claude.ai/api/mcp/auth_callback"), true);
    assert.equal(isDcrRedirectHostAllowed("https://claude.com/api/mcp/auth_callback"), true);
    assert.equal(isDcrRedirectHostAllowed("http://127.0.0.1:8787/cb"), true);
    assert.equal(isDcrRedirectHostAllowed("http://localhost:3000/cb"), true);
  });

  it("rejects attacker-controlled https hosts", () => {
    assert.equal(isDcrRedirectHostAllowed("https://attacker-alpha1.example.com/cb"), false);
    assert.equal(isDcrRedirectHostAllowed("https://example.invalid/cb"), false);
  });

  it("kills the 2026-09-15 probe client ids", () => {
    assert.equal(isDisabledClientId("hb_463ff2170ee445d094376c445d711a80"), true);
    assert.equal(isDisabledClientId("hb_6a8b7f092a2b4fc9a910b4b4c075b743"), true);
    assert.equal(isDisabledClientId("hb_not_a_probe"), false);
  });
});
