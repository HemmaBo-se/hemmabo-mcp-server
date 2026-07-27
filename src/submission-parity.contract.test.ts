/**
 * ChatGPT app submission parity gate.
 *
 * `submission/chatgpt-app-submission.json` is hand-maintained, and until this
 * gate existed nothing tied it to the runtime tool surface. It drifted: PR #282
 * removed `hemmabo_search_similar` + `hemmabo_compare_properties` from TOOLS,
 * but both kept their annotations, justifications and test cases in the
 * submission file, while the two live host-onboarding tools
 * (`hemmabo_host_readiness_check`, `hemmabo_host_onboarding_link`) had no entry
 * at all. A reviewer running the submitted test suite would have called two
 * tools that no longer exist and never exercised two that do.
 *
 * `mcp-tool-annotations.contract.test.ts` locks the runtime TOOLS array; this
 * is its submission-side sibling: whatever we tell OpenAI must be exactly what
 * the server exposes. Sibling of the facts-drift and description-sync gates.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TOOLS } from "../api/mcp.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUBMISSION_PATH = resolve(REPO_ROOT, "submission", "chatgpt-app-submission.json");

type Annotations = {
  readOnlyHint?: boolean;
  openWorldHint?: boolean;
  destructiveHint?: boolean;
};

type SubmissionTool = {
  annotations?: Annotations;
  justifications?: Record<string, string>;
};

type Submission = {
  app_info: { description: string };
  tools: Record<string, SubmissionTool>;
  test_cases: Array<{ tools_triggered: string | null }>;
};

const submission = JSON.parse(readFileSync(SUBMISSION_PATH, "utf8")) as Submission;

const ANNOTATION_KEYS = ["readOnlyHint", "openWorldHint", "destructiveHint"] as const;
const JUSTIFICATION_KEYS = [
  "read_only_justification",
  "open_world_justification",
  "destructive_justification",
] as const;

describe("chatgpt app submission parity", () => {
  it("declares exactly the tools the server exposes", () => {
    assert.deepEqual(
      Object.keys(submission.tools).sort(),
      TOOLS.map((t) => t.name).sort(),
      "submission/chatgpt-app-submission.json tools must match the runtime TOOLS array exactly — no removed tools left behind, no live tool missing."
    );
  });

  for (const tool of TOOLS) {
    it(`${tool.name} carries the server's own annotation triplet`, () => {
      const entry = submission.tools[tool.name];
      assert.ok(entry, `'${tool.name}' must have a submission entry`);
      const live = (tool.annotations ?? {}) as Annotations;
      const declared = entry.annotations ?? ({} as Annotations);
      for (const key of ANNOTATION_KEYS) {
        assert.equal(
          declared[key],
          live[key],
          `${tool.name}.${key}: submission says ${String(declared[key])}, server says ${String(live[key])}`
        );
      }
    });

    it(`${tool.name} justifies all three annotations`, () => {
      const justifications = submission.tools[tool.name]?.justifications ?? {};
      for (const key of JUSTIFICATION_KEYS) {
        const text = justifications[key];
        assert.ok(
          typeof text === "string" && text.trim().length > 0,
          `${tool.name}.${key} must be a non-empty justification — OpenAI requires one per annotation`
        );
      }
    });

    it(`${tool.name} has at least one test case`, () => {
      const covered = submission.test_cases.some((tc) => tc.tools_triggered === tool.name);
      assert.ok(covered, `no test_case triggers '${tool.name}' — the reviewer would never exercise it`);
    });
  }

  it("never points a test case at a tool the server does not expose", () => {
    const liveNames = new Set(TOOLS.map((t) => t.name));
    const unknown = submission.test_cases
      .map((tc) => tc.tools_triggered)
      .filter((name): name is string => typeof name === "string" && !liveNames.has(name));
    assert.deepEqual(unknown, [], `test_cases trigger tools that do not exist: ${unknown.join(", ")}`);
  });

  it("states a tool total that matches the runtime surface", () => {
    const match = submission.app_info.description.match(/(\d+) runtime tools/);
    assert.ok(match, "app_info.description must state the runtime tool total (e.g. '13 runtime tools')");
    assert.equal(
      Number(match[1]),
      TOOLS.length,
      `app_info.description claims ${match[1]} runtime tools but the server exposes ${TOOLS.length}`
    );
  });

  it("states sub-counts that add up to the tool total", () => {
    const subCounts = [...submission.app_info.description.matchAll(/(\d+) (?:HemmaBo federation|host onboarding|VRP verification) tools/g)].map(
      (m) => Number(m[1])
    );
    assert.equal(subCounts.length, 3, "description must break the total into federation, host onboarding and VRP counts");
    assert.equal(
      subCounts.reduce((a, b) => a + b, 0),
      TOOLS.length,
      `description sub-counts ${subCounts.join(" + ")} do not sum to ${TOOLS.length}`
    );
  });
});
