import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, PROMPTS } from "../api/mcp.js";
import { VRP_TOOL_NAMES } from "../lib/vrp.js";

// claude.ai's web frontend validates MCP tool/prompt names against
// ^[a-zA-Z0-9_-]{1,64}$ and rejects anything else (ADR-0001 / #59 — dotted
// tool names were silently unusable there until renamed to snake_case). This
// guard closes the whole class proactively: every MCP-exposed *name* must be
// broadly compatible, so we never have to react to a single client's UI quirk
// one bug at a time.
//
// Scope note: this regex governs NAMES (tools, prompts). Resources are
// addressed by URI (e.g. ui://hemmabo/verified-stay-offer-v6), whose scheme
// legitimately contains ':' and '/', so resource URIs are intentionally not
// subject to this rule.
const MCP_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

describe("MCP-exposed names are broadly client-compatible", () => {
  for (const tool of TOOLS) {
    it(`tool name "${tool.name}" matches ^[a-zA-Z0-9_-]{1,64}$`, () => {
      assert.match(tool.name, MCP_NAME_RE);
      assert.equal(tool.name.includes("."), false, `tool name must not contain a dot: ${tool.name}`);
    });
  }

  for (const prompt of PROMPTS) {
    it(`prompt name "${prompt.name}" matches ^[a-zA-Z0-9_-]{1,64}$`, () => {
      assert.match(prompt.name, MCP_NAME_RE);
      assert.equal(prompt.name.includes("."), false, `prompt name must not contain a dot: ${prompt.name}`);
    });
  }

  it("there is at least one tool and one prompt to check (guards against an empty import)", () => {
    assert.ok(TOOLS.length > 0, "TOOLS must not be empty");
    assert.ok(PROMPTS.length > 0, "PROMPTS must not be empty");
  });
});

// Two namespaces (ADR 0001 §2.4, amendment 2026-10-11): product tools carry
// `hemmabo_`, protocol tools carry `vrp_`, and every name is verb_noun. VRP is
// an open standard, so a VRP tool never carries the `hemmabo_` prefix. Add a
// verb here only when a new tool needs one.
const TOOL_VERBS = ["search", "check", "get", "verify"];
const NAMESPACED_VERB_NOUN_RE = new RegExp(`^(hemmabo|vrp)_(${TOOL_VERBS.join("|")})(_[a-z]+)+$`);

describe("tool names: hemmabo_ for product tools, vrp_ for protocol tools, verb_noun", () => {
  for (const tool of TOOLS) {
    it(`tool name "${tool.name}" is a namespaced verb_noun`, () => {
      assert.match(tool.name, NAMESPACED_VERB_NOUN_RE);
      const isVrpTool = (VRP_TOOL_NAMES as readonly string[]).includes(tool.name);
      assert.equal(
        tool.name.startsWith("vrp_"),
        isVrpTool,
        `${tool.name}: VRP tools carry vrp_, every other tool carries hemmabo_`,
      );
    });
  }
});
