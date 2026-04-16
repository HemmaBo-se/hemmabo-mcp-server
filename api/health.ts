import type { VercelRequest, VercelResponse } from "@vercel/node";

// IMPORTANT: Keep in sync with package.json version
const VERSION = "3.1.17";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.json({ status: "ok", version: VERSION });
}
