import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTokenRequestParams } from "../lib/oauth-body.js";

// RFC 6749 §3.2: the token endpoint MUST accept
// application/x-www-form-urlencoded. On Vercel the runtime pre-parses the body
// into an object for both form and JSON, so the regression to guard is the
// form case arriving as an object.
describe("parseTokenRequestParams (RFC 6749 token body)", () => {
  it("reads a Vercel-parsed form-urlencoded body (object) — the regression case", () => {
    const p = parseTokenRequestParams("application/x-www-form-urlencoded", {
      grant_type: "client_credentials",
      client_id: "hb_x",
      client_secret: "secret",
      scope: "mcp",
    });
    assert.equal(p.grant_type, "client_credentials");
    assert.equal(p.client_id, "hb_x");
    assert.equal(p.client_secret, "secret");
    assert.equal(p.scope, "mcp");
  });

  it("reads a raw form-urlencoded string body (body parsing disabled)", () => {
    const p = parseTokenRequestParams(
      "application/x-www-form-urlencoded",
      "grant_type=authorization_code&code=abc&redirect_uri=https%3A%2F%2Fx.io%2Fcb&code_verifier=v",
    );
    assert.equal(p.grant_type, "authorization_code");
    assert.equal(p.code, "abc");
    assert.equal(p.redirect_uri, "https://x.io/cb");
    assert.equal(p.code_verifier, "v");
  });

  it("reads a JSON object body", () => {
    const p = parseTokenRequestParams("application/json", {
      grant_type: "refresh_token",
      refresh_token: "rt",
      client_id: "hb_y",
    });
    assert.equal(p.grant_type, "refresh_token");
    assert.equal(p.refresh_token, "rt");
    assert.equal(p.client_id, "hb_y");
  });

  it("reads a raw JSON string body", () => {
    const p = parseTokenRequestParams(
      "application/json",
      JSON.stringify({ grant_type: "client_credentials", client_id: "hb_z" }),
    );
    assert.equal(p.grant_type, "client_credentials");
    assert.equal(p.client_id, "hb_z");
  });

  it("ignores unknown and non-string keys", () => {
    const p = parseTokenRequestParams("application/json", {
      grant_type: "client_credentials",
      bogus: "x",
      scope: 123,
    });
    assert.equal(p.grant_type, "client_credentials");
    assert.equal("bogus" in p, false);
    assert.equal(p.scope, undefined);
  });

  it("returns an empty object for an absent/empty body", () => {
    assert.deepEqual(parseTokenRequestParams("application/json", undefined), {});
    assert.deepEqual(parseTokenRequestParams("application/x-www-form-urlencoded", ""), {});
  });
});
