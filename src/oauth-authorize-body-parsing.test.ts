import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAuthorizeRequestParams } from "../lib/oauth-body.js";

// The /oauth/authorize consent form POSTs application/x-www-form-urlencoded.
// On Vercel the runtime pre-parses that body into an OBJECT, so the regression
// to guard is the form case arriving as an object — the original handler read
// only a raw string and dropped every field, surfacing as "Missing client_id"
// after the user clicked "Connect". See lib/oauth-body.ts.
describe("parseAuthorizeRequestParams (RFC 6749 §4.1.1 consent POST body)", () => {
  it("reads a Vercel-parsed form-urlencoded body (object) — the regression case", () => {
    const p = parseAuthorizeRequestParams("application/x-www-form-urlencoded", {
      response_type: "code",
      client_id: "hb_abc",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      state: "st",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      scope: "mcp",
      decision: "approve",
    });
    assert.equal(p.client_id, "hb_abc");
    assert.equal(p.redirect_uri, "https://claude.ai/api/mcp/auth_callback");
    assert.equal(p.code_challenge_method, "S256");
    assert.equal(p.decision, "approve");
  });

  it("reads a raw form-urlencoded string body (body parsing disabled)", () => {
    const p = parseAuthorizeRequestParams(
      "application/x-www-form-urlencoded",
      "response_type=code&client_id=hb_x&redirect_uri=https%3A%2F%2Fx.io%2Fcb&decision=approve",
    );
    assert.equal(p.response_type, "code");
    assert.equal(p.client_id, "hb_x");
    assert.equal(p.redirect_uri, "https://x.io/cb");
    assert.equal(p.decision, "approve");
  });

  it("reads a JSON object body", () => {
    const p = parseAuthorizeRequestParams("application/json", {
      client_id: "hb_y",
      decision: "deny",
    });
    assert.equal(p.client_id, "hb_y");
    assert.equal(p.decision, "deny");
  });

  it("ignores unknown and non-string keys", () => {
    const p = parseAuthorizeRequestParams("application/x-www-form-urlencoded", {
      client_id: "hb_z",
      bogus: "x",
      state: 123,
    });
    assert.equal(p.client_id, "hb_z");
    assert.equal("bogus" in p, false);
    assert.equal(p.state, undefined);
  });

  it("returns an empty object for an absent/empty body (so the handler renders Missing client_id, not a crash)", () => {
    assert.deepEqual(parseAuthorizeRequestParams("application/x-www-form-urlencoded", undefined), {});
    assert.deepEqual(parseAuthorizeRequestParams("application/x-www-form-urlencoded", ""), {});
  });
});
