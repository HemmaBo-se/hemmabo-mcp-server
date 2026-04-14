import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readFileSync } from "fs";
import { join } from "path";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.json({ status: "ok", version: pkg.version });
}
