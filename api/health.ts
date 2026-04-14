import type { VercelRequest, VercelResponse } from "@vercel/node";
import pkg from "../package.json";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.json({ status: "ok", version: pkg.version });
}
