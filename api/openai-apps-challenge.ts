/**
 * OpenAI ChatGPT Apps domain verification challenge.
 *
 * The OpenAI Apps submission form requires us to prove control over the
 * MCP hostname (hemmabo-mcp-server.vercel.app) by serving a specific
 * verification token at:
 *
 *   https://<host>/.well-known/openai-apps-challenge
 *
 * The token is generated per-app by OpenAI when the developer enters
 * Domain verification on the MCP Server tab. It is not secret — it only
 * proves that whoever pushes code to this repo also controls the host.
 *
 * Returns the token as plain text. Same pattern as Google Search Console
 * site verification, GitHub Pages CNAME challenges, etc.
 */

import type { VercelRequest, VercelResponse } from "./_types.js";

// Token issued by OpenAI Apps submission form for this app
// (asdk_app_69fccc58e3088191a22cffe6fd5ad075). Safe to commit — it
// proves repo+host control to OpenAI, nothing more.
const OPENAI_APPS_CHALLENGE_TOKEN = "UHOgav2TArtuSsYJQKGAlTxJmLBkhk46KPfy1Bv0Eds";

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("method_not_allowed");

  return res.status(200).send(OPENAI_APPS_CHALLENGE_TOKEN);
}
