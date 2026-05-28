import { executeTool as executeHemmaboTool } from "./tools-base.js";
import { executeVrpTool, isVrpToolName } from "./vrp.js";
import type { ToolClients, ToolResult } from "./tools-base.js";

export {
  normalizeToolName,
  validateDates,
  validateDateOrder,
  validateRequiredArgs,
  normalizeLocationTerm,
  expandLocationTerms,
  propertyMatchesLocation,
  buildSameMonthDateWindows,
} from "./tools-base.js";
export type { ToolClients, ToolResult } from "./tools-base.js";

function withStructuredContent(result: ToolResult): ToolResult {
  if (result.structuredContent) return result;
  const text = result.content?.[0]?.text;
  if (typeof text !== "string") return result;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...result, structuredContent: parsed as Record<string, unknown> };
    }
  } catch {
    // Keep plain-text tool results as-is.
  }
  return result;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  clients: ToolClients
): Promise<ToolResult> {
  const result = isVrpToolName(name)
    ? await executeVrpTool(name, args)
    : await executeHemmaboTool(name, args, clients);
  return withStructuredContent(result);
}
