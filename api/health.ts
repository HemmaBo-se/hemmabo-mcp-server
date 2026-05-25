import type { VercelRequest, VercelResponse } from "./_types.js";
import { SERVER_VERSION } from "../lib/server-metadata.js";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.json({ status: "ok", version: SERVER_VERSION });
}
