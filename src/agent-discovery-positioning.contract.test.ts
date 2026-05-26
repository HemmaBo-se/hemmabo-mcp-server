import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_DESCRIPTION, SERVER_INSTRUCTIONS } from "../lib/server-metadata.js";
import manifestHandler from "../api/mcp-manifest.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

function lower(value: string): string {
  return value.toLowerCase();
}

const TEXT_SURFACES: Record<string, string> = {
  "README.md": read("README.md"),
  "llms.txt": read("llms.txt"),
  "project.faf": read("project.faf"),
  "lib/server-metadata.ts": `${SERVER_DESCRIPTION}\n${SERVER_INSTRUCTIONS}`,
  "glama.json description": JSON.parse(read("glama.json")).description,
  "server.json description": JSON.parse(read("server.json")).description,
  "package.json description": JSON.parse(read("package.json")).description,
  "smithery.yaml": read("smithery.yaml"),
};

const REQUIRED_POSITIONING = [
  "infrastructure and federation",
  "host-owned vacation rental",
  "host-domain verified stay offer",
  "host nodes own booking lifecycles",
  "stripe owns payment facts",
  "not an ota",
  "not a marketplace",
  "website builder",
  "hemmabo + vrp, 13 tools",
  "host-domain signed verified stay offers",
];

describe("agent discovery positioning contract", () => {
  for (const [name, content] of Object.entries(TEXT_SURFACES)) {
    it(`${name} keeps HemmaBo's agent-facing role clear`, () => {
      const text = lower(content);
      for (const phrase of REQUIRED_POSITIONING) {
        assert.ok(
          text.includes(phrase),
          `${name} must include positioning phrase: ${phrase}`,
        );
      }
    });
  }

  it("README and llms.txt tell agents when an offer may be quoted as official", () => {
    for (const file of ["README.md", "llms.txt"]) {
      const text = lower(read(file));
      assert.ok(text.includes("safe-to-quote"), `${file} must mention safe-to-quote verification`);
      assert.ok(text.includes("fresh"), `${file} must mention freshness`);
      assert.ok(text.includes("signed"), `${file} must mention signatures`);
    }
  });

  it("runtime manifest exposes host-node and Stripe ownership boundaries", async () => {
    const captured: Record<string, unknown> = {};
    const fakeRes = {
      setHeader: () => {},
      json: (body: Record<string, unknown>) => Object.assign(captured, body),
    };

    await manifestHandler({} as never, fakeRes as never);

    const description = lower(String(captured.description ?? ""));
    for (const phrase of REQUIRED_POSITIONING) {
      assert.ok(
        description.includes(phrase),
        `runtime manifest description must include: ${phrase}`,
      );
    }

    const trust = captured.trust as Record<string, unknown>;
    assert.equal(trust.payment, "Stripe (direct to host)");
    assert.equal(trust.commission, "0%");
    assert.equal(trust.data_ownership, "host");
    assert.equal(trust.booking_lifecycle_owner, "host node");
    assert.equal(trust.payment_facts_owner, "Stripe");
    assert.equal(trust.hemmabo_role, "infrastructure and federation");
    assert.equal(trust.vrp, "host-domain signed verified stay offers");
  });

  it("does not revive broad hotel/OTA positioning in project metadata", () => {
    const project = lower(read("project.faf"));
    assert.equal(project.includes("mirai for hotels"), false);
    assert.equal(project.includes("hotel search engine"), false);
    assert.equal(project.includes("marketplace with many providers"), true);
  });
});
