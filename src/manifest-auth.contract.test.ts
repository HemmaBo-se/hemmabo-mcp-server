import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { ANON_TOOLS, TOOLS } from "../api/mcp.js";
import manifestHandler from "../api/mcp-manifest.js";
import serverCardHandler from "../api/server-card.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
type Tool = { name: string; auth?: "none" | "bearer"; annotations?: { readOnlyHint?: boolean } };
type ServerCard = {
  serverInfo: {
    name: string;
    title: string;
    version: string;
    homepage: string;
    icon: string;
    iconUrl: string;
  };
  tools: Tool[];
};

function captureJson(handler: (req: any, res: any) => unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const fakeRes = {
      setHeader: () => {},
      json: (body: unknown) => resolve(body),
      status: () => fakeRes,
    };
    try {
      handler({ method: "GET", headers: {} }, fakeRes);
    } catch (e) {
      reject(e);
    }
  });
}

describe("manifest per-tool auth contract", () => {
  it("ANON_TOOLS contains the canonical 7 read-only tools", () => {
    for (const name of [
      "hemmabo_search_properties",
      "hemmabo_search_availability",
      "hemmabo_booking_quote",
      "hemmabo_host_readiness_check",
      "hemmabo_host_onboarding_link",
      "verify_vacation_rental_node",
      "get_verified_stay_offer",
    ]) {
      assert.ok(ANON_TOOLS.has(name), `ANON_TOOLS missing ${name}`);
    }
  });

  it("/.well-known/mcp.json exposes auth for all 13 tools", async () => {
    const body = (await captureJson(manifestHandler as never)) as { tools: Tool[] };
    assert.ok(Array.isArray(body.tools), "manifest must have tools[]");
    assert.equal(body.tools.length, 13, "manifest must list all 13 tools");

    for (const t of body.tools) {
      assert.ok(t.auth === "none" || t.auth === "bearer", `tool ${t.name} must declare auth`);
      const expected: "none" | "bearer" = ANON_TOOLS.has(t.name) ? "none" : "bearer";
      assert.equal(t.auth, expected, `tool ${t.name} expected auth=${expected}`);
    }
  });

  it("server-card endpoint annotates every tool with auth", async () => {
    const body = (await captureJson(serverCardHandler as never)) as { tools: Tool[] };
    assert.ok(Array.isArray(body.tools));
    assert.equal(body.tools.length, TOOLS.length);

    for (const t of body.tools) {
      const expected: "none" | "bearer" = ANON_TOOLS.has(t.name) ? "none" : "bearer";
      assert.equal(t.auth, expected, `server-card tool ${t.name} expected auth=${expected}`);
    }
  });

  it("server-card endpoint exposes non-stale registry metadata", async () => {
    const body = (await captureJson(serverCardHandler as never)) as ServerCard;
    assert.equal(body.serverInfo.name, "hemmabo-mcp-server");
    assert.equal(body.serverInfo.title, "HemmaBo Host Booking Engine");
    assert.equal(body.serverInfo.version, pkg.version);
    assert.equal(body.serverInfo.homepage, "https://www.hemmabo.com");
    // Canonical icon: same origin as remotes[0].url (https://www.hemmabo.com/mcp),
    // direct 200 image/png (www.hemmabo.com/icon.png is a 308 to this file).
    const ICON = "https://www.hemmabo.com/hemmabo-icon-512.png";
    assert.equal(body.serverInfo.icon, ICON);
    assert.equal(body.serverInfo.iconUrl, ICON);
    const serverJson = createRequire(import.meta.url)("../server.json") as { icons: Array<{ src: string }> };
    assert.equal(serverJson.icons[0]?.src, ICON, "server.json icons[0].src must match the runtime icon URL");
  });

  it("anon manifest entries match readOnlyHint annotation", async () => {
    const body = (await captureJson(serverCardHandler as never)) as { tools: Tool[] };
    for (const t of body.tools) {
      if (t.auth === "none") {
        assert.equal(t.annotations?.readOnlyHint, true, `tool ${t.name} declares auth:none but is not read-only`);
      }
    }
  });
});
