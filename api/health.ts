import type { VercelRequest, VercelResponse } from "@vercel/node";

// IMPORTANT: Keep in sync with package.json version
const VERSION = "3.2.4";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.json({ status: "ok", version: VERSION });
}
