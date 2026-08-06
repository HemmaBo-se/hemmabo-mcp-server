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
import { TOOLS, CHATGPT_TOOL_NAMES } from "../api/mcp.js";

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

// The OpenAI app connects to the dedicated ChatGPT surface (/mcp/chatgpt),
// which exposes ONLY CHATGPT_TOOL_NAMES. The submission must therefore mirror
// that surface — NOT the full /mcp federation surface (TOOLS, 13). See the
// McpSurface gate in api/mcp.ts and the OpenAI-rejection decode doc.
const CHATGPT_TOOLS = TOOLS.filter((t) => CHATGPT_TOOL_NAMES.has(t.name));

const ANNOTATION_KEYS = ["readOnlyHint", "openWorldHint", "destructiveHint"] as const;
const JUSTIFICATION_KEYS = [
  "read_only_justification",
  "open_world_justification",
  "destructive_justification",
] as const;

// Words/phrases that carry the OpenAI commerce / digital-service rejection.
// The submission description must stay clear of them (physical-goods-only rule).
const FORBIDDEN_DESCRIPTION_PHRASES = [
  "booking website",
  "runtime tools",
  "host onboarding",
  "subscription",
  "checkout",
];

describe("chatgpt app submission parity (ChatGPT surface)", () => {
  it("declares exactly the tools the ChatGPT surface exposes", () => {
    assert.deepEqual(
      Object.keys(submission.tools).sort(),
      CHATGPT_TOOLS.map((t) => t.name).sort(),
      "submission/chatgpt-app-submission.json tools must match the /mcp/chatgpt surface (CHATGPT_TOOL_NAMES) exactly — no booking/checkout/host-onboarding tools, no verification tool missing."
    );
  });

  for (const tool of CHATGPT_TOOLS) {
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

  it("never points a test case at a tool outside the ChatGPT surface", () => {
    const allowed = new Set(CHATGPT_TOOLS.map((t) => t.name));
    const unknown = submission.test_cases
      .map((tc) => tc.tools_triggered)
      .filter((name): name is string => typeof name === "string" && !allowed.has(name));
    assert.deepEqual(unknown, [], `test_cases trigger tools outside the ChatGPT surface: ${unknown.join(", ")}`);
  });

  it("keeps the description free of in-chat commerce / SaaS language", () => {
    const desc = submission.app_info.description.toLowerCase();
    for (const phrase of FORBIDDEN_DESCRIPTION_PHRASES) {
      assert.ok(
        !desc.includes(phrase),
        `app_info.description must not contain '${phrase}' — it re-triggers the OpenAI commerce/digital-service rejection`
      );
    }
  });
});
