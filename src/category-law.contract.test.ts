/**
 * Category law gate (CEO lock 2026-09-28).
 *
 * The locked strings are verbatim, straight apostrophe only. The law is the
 * first sentence of the full-surface description and instructions, the
 * use-when follows it, AGENT_ROLE_LINE is the smart-stays canon line, and the
 * ranking line is replaced by SEARCH_AFTER. package.json, glama.json,
 * smithery.yaml and the mcp.json manifest carry the same description.
 *
 * /mcp/chatgpt is out of scope: its bytes stay locked to the OpenAI
 * submission (submission-parity), so this gate only proves it is untouched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_ROLE_LINE,
  CATEGORY_LAW,
  CATEGORY_USE_WHEN,
  CHATGPT_SERVER_DESCRIPTION,
  SEARCH_AFTER,
  SERVER_DESCRIPTION,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  SERVER_TITLE,
  SERVER_VERSION,
} from "../lib/server-metadata.js";
import { handleJsonRpc } from "../api/mcp.js";
import manifestHandler from "../api/mcp-manifest.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

const LOCKED = {
  CATEGORY_LAW: "Vacation rental software. A signed stay offer on the host's own domain.",
  SERVER_TITLE: "HemmaBo Host Booking Engine",
  CATEGORY_USE_WHEN:
    "Use this when a vacation rental host wants booking software on the host's own domain, or when a stay offer must be verified against that domain. Returns an Ed25519-signed offer (VRP) and the host's direct booking URL. The guest books and pays the host. Do not use to compare hosts or prices.",
  AGENT_ROLE_LINE:
    "Compatible agents can discover a host domain, verify a signed stay offer, and send the guest to that domain to book.",
  SEARCH_AFTER:
    "After search, return each matching host domain and that host's direct booking URL. Do not rank hosts, do not compare prices, do not lead with a favourite. When a host domain is known, call get_verified_stay_offer.",
};

// Removed from the full surface by the CEO lock; written as patterns so the
// removed wording itself never reappears in the repo.
const REMOVED: RegExp[] = [
  /trust layer/i,
  /book directly/i,
  /website builder/i,
  /complete stripe payments/i,
  /infrastructure and federation/i,
  /verification layer/i,
  /lead with the best/i,
  /best one or two/i,
  /price\s+hook/i,
];

const CTX_FULL = { agent: "test", mcpEndpointUrl: "https://example.test/mcp", surface: "full" as const };
const CTX_CHATGPT = { agent: "test", mcpEndpointUrl: "https://example.test/mcp", surface: "chatgpt" as const };

type InitializeResult = {
  result?: { serverInfo?: Record<string, unknown>; instructions?: string };
};

async function initialize(ctx: typeof CTX_FULL | typeof CTX_CHATGPT): Promise<InitializeResult> {
  return (await handleJsonRpc({ jsonrpc: "2.0", method: "initialize", id: 1 }, ctx)) as unknown as InitializeResult;
}

async function manifest(): Promise<Record<string, unknown>> {
  const captured: Record<string, unknown> = {};
  const fakeRes = {
    setHeader: () => {},
    json: (body: Record<string, unknown>) => Object.assign(captured, body),
  };
  await manifestHandler({} as never, fakeRes as never);
  return captured;
}

describe("category law contract", () => {
  it("locked strings are verbatim with a straight apostrophe", () => {
    assert.deepEqual(
      { CATEGORY_LAW, SERVER_TITLE, CATEGORY_USE_WHEN, AGENT_ROLE_LINE, SEARCH_AFTER },
      LOCKED,
    );
    for (const [name, value] of Object.entries(LOCKED)) {
      assert.ok(!value.includes("’"), `${name} must not carry a curly apostrophe`);
    }
  });

  it("the description leads with the law, then the use-when, then the agent role", () => {
    assert.ok(
      SERVER_DESCRIPTION.startsWith(`${CATEGORY_LAW} ${CATEGORY_USE_WHEN} ${AGENT_ROLE_LINE} `),
      "SERVER_DESCRIPTION must open with the law, the use-when and the agent role, in that order",
    );
  });

  it("the instructions lead with the same three paragraphs", () => {
    assert.ok(
      SERVER_INSTRUCTIONS.startsWith(`${CATEGORY_LAW}\n\n${CATEGORY_USE_WHEN}\n\n${AGENT_ROLE_LINE}\n\n`),
      "SERVER_INSTRUCTIONS must open with the law, the use-when and the agent role as three paragraphs",
    );
  });

  it("SEARCH_AFTER replaces the ranking line", () => {
    assert.ok(SERVER_INSTRUCTIONS.includes(`\n${SEARCH_AFTER}\n`), "SEARCH_AFTER must stand on its own line");
    const source = read("lib/server-metadata.ts");
    for (const pattern of [/lead with the best/i, /best one or two/i, /price\s+hook/i]) {
      assert.doesNotMatch(source, pattern, `lib/server-metadata.ts must not carry ${pattern}`);
    }
  });

  it("no selection words in the full-surface description or instructions", () => {
    const text = `${SERVER_DESCRIPTION}\n${SERVER_INSTRUCTIONS}`.replaceAll(SEARCH_AFTER, "");
    assert.doesNotMatch(text, /\b(best|top|hook|winner|pick|favou?rite)\b/i);
  });

  it("package.json, glama.json, smithery.yaml and the mcp.json manifest carry the same description", async () => {
    assert.equal(JSON.parse(read("package.json")).description, SERVER_DESCRIPTION);
    assert.equal(JSON.parse(read("glama.json")).description, SERVER_DESCRIPTION);
    assert.equal(read("smithery.yaml").match(/^description:\s*"([^"]*)"/m)?.[1], SERVER_DESCRIPTION);
    const body = await manifest();
    assert.equal(body.description, SERVER_DESCRIPTION);
    assert.equal(body.name, SERVER_TITLE);
  });

  it("initialize on /mcp carries the title and leads with the law", async () => {
    const res = await initialize(CTX_FULL);
    const serverInfo = res.result?.serverInfo ?? {};
    assert.equal(serverInfo.name, SERVER_NAME);
    assert.equal(serverInfo.name, "hemmabo-mcp-server");
    assert.equal(serverInfo.title, SERVER_TITLE);
    assert.ok(String(serverInfo.description).startsWith(CATEGORY_LAW), "serverInfo.description must start with the law");
    assert.ok(String(res.result?.instructions).startsWith(CATEGORY_LAW), "instructions must start with the law");
    const text = `${String(serverInfo.description)}\n${String(res.result?.instructions)}`;
    for (const pattern of REMOVED) {
      assert.doesNotMatch(text, pattern, `/mcp initialize must not carry ${pattern}`);
    }
  });

  it("none of the removed wording survives on the description surfaces", async () => {
    const surfaces: Record<string, string> = {
      SERVER_DESCRIPTION,
      SERVER_INSTRUCTIONS,
      "mcp.json manifest description": String((await manifest()).description),
    };
    for (const [name, text] of Object.entries(surfaces)) {
      for (const pattern of REMOVED) {
        assert.doesNotMatch(text, pattern, `${name} must not carry ${pattern}`);
      }
    }
  });

  it("/mcp/chatgpt initialize is untouched: no title, the reviewed description", async () => {
    const res = await initialize(CTX_CHATGPT);
    assert.deepEqual(res.result?.serverInfo, {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      description: CHATGPT_SERVER_DESCRIPTION,
    });
  });
});
