import { executeTool as executeHemmaboTool } from "./tools-base.js";
import { executeVrpTool, isVrpToolName } from "./vrp.js";
import { executeHostOnboardingTool, isHostOnboardingToolName } from "./host-onboarding.js";
import { HEMMABO_WIDGET_TOOL_META } from "./apps-widget.js";
import type { ToolClients, ToolResult } from "./tools-base.js";

const WIDGET_RESULT_TOOL_NAMES = new Set([
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
} from "./tools-base.js";
export { isHostOnboardingToolName } from "./host-onboarding.js";
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

// Canonical date params are camelCase across every tool. These are the only
// legacy snake_case names we still accept, mapped to their camelCase form.
const DATE_PARAM_ALIASES: Record<string, string> = {
  check_in: "checkIn",
  check_out: "checkOut",
  new_check_in: "newCheckIn",
  new_check_out: "newCheckOut",
};

/**
 * Map legacy snake_case date params to the canonical camelCase names. This is a
 * targeted migration alias, not a blanket relaxation: only these known date
 * keys are translated (and the legacy key is removed so additionalProperties
 * stays strict), so #85's "reject unknown keys so agents self-correct" still
 * catches real typos. Must run before validation/dispatch — callers like
 * api/mcp.ts apply it to the raw args before validateToolArgs.
 */
export function normalizeDateAliases(args: Record<string, unknown>): Record<string, unknown> {
  let copy: Record<string, unknown> | null = null;
  for (const [legacy, canonical] of Object.entries(DATE_PARAM_ALIASES)) {
    if (args[legacy] !== undefined) {
      copy ??= { ...args };
      if (copy[canonical] === undefined) copy[canonical] = args[legacy];
      delete copy[legacy];
    }
  }
  return copy ?? args;
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
  const toolArgs = normalizeDateAliases(args);
  const result = isHostOnboardingToolName(name)
    ? await executeHostOnboardingTool(name, toolArgs)
    : isVrpToolName(name)
    ? await executeVrpTool(name, toolArgs)
    : await executeHemmaboTool(name, toolArgs, clients);
  return withWidgetTemplate(name, withStructuredContent(result));
}
