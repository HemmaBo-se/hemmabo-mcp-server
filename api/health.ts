import type { VercelRequest, VercelResponse } from "./_types.js";

// IMPORTANT: Keep in sync with package.json version
const VERSION = "3.2.6";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.json({ status: "ok", version: VERSION });
}
