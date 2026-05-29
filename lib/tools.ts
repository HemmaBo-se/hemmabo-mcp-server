import { executeTool as executeHemmaboTool } from "./tools-base.js";
import { executeVrpTool, isVrpToolName } from "./vrp.js";
import { HEMMABO_WIDGET_TOOL_META } from "./apps-widget.js";
import type { ToolClients, ToolResult } from "./tools-base.js";

const WIDGET_RESULT_TOOL_NAMES = new Set([
  "hemmabo_search_properties",
  "get_verified_stay_offer",
]);

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

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function withWidgetTemplate(name: string, result: ToolResult): ToolResult {
  if (!WIDGET_RESULT_TOOL_NAMES.has(name)) return result;
  const existingMeta = result._meta ?? {};
  return {
    ...result,
    _meta: {
      ...HEMMABO_WIDGET_TOOL_META,
      ...existingMeta,
      ui: {
        ...HEMMABO_WIDGET_TOOL_META.ui,
        ...recordValue(existingMeta.ui),
      },
    },
  };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  clients: ToolClients
): Promise<ToolResult> {
  const result = isVrpToolName(name)
    ? await executeVrpTool(name, args)
    : await executeHemmaboTool(name, args, clients);
  return withWidgetTemplate(name, withStructuredContent(result));
}
