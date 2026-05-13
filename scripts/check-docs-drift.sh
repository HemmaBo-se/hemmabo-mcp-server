#!/usr/bin/env bash
#
# check-docs-drift.sh — fail CI if public-facing documents reference legacy
# dotted MCP tool names (e.g. "search.properties", "booking.quote").
#
# Canonical wire names are snake_case (#59). Dotted names remain accepted as
# inbound aliases via lib/tools.ts:TOOL_NAME_ALIASES, but they MUST NOT appear
# in user-facing prose where they would set the wrong expectation about what
# clients see in tools/list output.
#
# Allowed: alias-map entries in lib/tools.ts, ANON_TOOLS dotted fallbacks in
#          api/mcp.ts (both source code, audited by reviewers).
# Forbidden: README.md, llms.txt, LAUNCHGUIDE.md, glama.json,
#            submission/chatgpt-app-submission.json (docs).
#
# Exits 0 on clean, 1 on drift.

set -euo pipefail

DOC_FILES=(
  "README.md"
  "llms.txt"
  "LAUNCHGUIDE.md"
  "glama.json"
  "submission/chatgpt-app-submission.json"
)

# Match "search.properties" / "booking.quote" etc. in any quoting style.
DOTTED_RE='"(search|booking)\.(properties|availability|similar|compare|quote|create|negotiate|checkout|cancel|status|reschedule)"|`(search|booking)\.(properties|availability|similar|compare|quote|create|negotiate|checkout|cancel|status|reschedule)`'

drift=0
for f in "${DOC_FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "::warning::docs-drift check: $f missing — skipping"
    continue
  fi
  # Lines that mention a dotted name AS A TOOL NAME (quoted or backticked).
  # Plain-prose mentions outside backticks are allowed (e.g. "the dotted
  # alias scheme") because they read as exposition, not API surface.
  matches=$(grep -EHn "$DOTTED_RE" "$f" || true)
  # Allow lines that explicitly mark the name as a "legacy alias" so the
  # alias-retention paragraph in README/LAUNCHGUIDE keeps working.
  matches=$(echo "$matches" | grep -viE 'legacy|alias|inbound' || true)
  if [[ -n "$matches" ]]; then
    echo "::error::docs-drift in $f — dotted tool names found:"
    echo "$matches"
    drift=1
  fi
done

if [[ $drift -ne 0 ]]; then
  echo ""
  echo "Fix: replace dotted names with snake_case canonical (e.g."
  echo "     'search.properties' → 'hemmabo_search_properties'). Aliases"
  echo "     remain in source code only — see lib/tools.ts:TOOL_NAME_ALIASES."
  exit 1
fi

echo "docs-drift check: OK — no dotted tool names in public docs."
