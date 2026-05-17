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

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  clients: ToolClients
): Promise<ToolResult> {
  if (isVrpToolName(name)) return executeVrpTool(name, args);
  return executeHemmaboTool(name, args, clients);
}
