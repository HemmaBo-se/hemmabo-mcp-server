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

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function extractProjectFafSection(content: string, sectionName: string): string {
  const normalized = normalizeNewlines(content);
  const start = normalized.indexOf(`${sectionName}:\n`);
  assert.notEqual(start, -1, `project.faf must include ${sectionName}`);

  const afterStart = start + sectionName.length + 2;
  const nextTopLevelSection = normalized.slice(afterStart).match(/\n[a-z_]+:\n/);
  const end = nextTopLevelSection
    ? afterStart + nextTopLevelSection.index!
    : normalized.length;

  return normalized.slice(afterStart, end);
}

function jsonKeywords(relPath: string): string[] {
  const parsed = JSON.parse(read(relPath)) as { keywords?: unknown };
  assert.ok(Array.isArray(parsed.keywords), `${relPath} must define keywords`);
  return parsed.keywords.map((keyword) => String(keyword).toLowerCase());
}

function smitheryKeywords(): string[] {
  const source = normalizeNewlines(read("smithery.yaml"));
  const match = source.match(/\nkeywords:\n(?<block>(?:\s+-\s+.+\n)+)/);
  assert.ok(match?.groups?.block, "smithery.yaml must define keywords");

  return match.groups.block
    .trim()
    .split("\n")
    .map((line) => line.replace(/^\s+-\s+/, "").trim().toLowerCase());
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
  "hemmabo + vrp, 15 runtime tools",
  "host onboarding",
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
    const rawProject = normalizeNewlines(read("project.faf"));
    const project = lower(rawProject);
    const rawDoNotUseWhen = extractProjectFafSection(rawProject, "do_not_use_when");
    const doNotUseWhen = lower(rawDoNotUseWhen);
    const projectWithoutDoNotUseWhen = lower(rawProject.replace(rawDoNotUseWhen, ""));

    assert.equal(project.includes("mirai for hotels"), false);
    assert.equal(project.includes("hotel search engine"), false);
    assert.equal(doNotUseWhen.includes("marketplace with many providers"), true);
    assert.equal(projectWithoutDoNotUseWhen.includes("marketplace with many providers"), false);
  });

  it("registry keywords do not use OTA or vendor-alternative positioning", () => {
    const keywordSurfaces: Record<string, string[]> = {
      "package.json": jsonKeywords("package.json"),
      "glama.json": jsonKeywords("glama.json"),
      "smithery.yaml": smitheryKeywords(),
    };

    const forbiddenFragments = [
      "airbnb",
      "booking.com",
      "bookingcom",
      "lodgify",
      "wix",
      "ota",
      "marketplace",
    ];

    for (const [surface, keywords] of Object.entries(keywordSurfaces)) {
      for (const keyword of keywords) {
        for (const fragment of forbiddenFragments) {
          assert.equal(
            keyword.includes(fragment),
            false,
            `${surface} keyword "${keyword}" must not position HemmaBo as ${fragment}`,
          );
        }
      }
    }
  });
});
