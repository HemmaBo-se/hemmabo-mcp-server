#!/usr/bin/env bash
#
# check-facts-drift.sh — fail CI if a LIVE public/agent-facing surface states a
# WRONG language count or tool count. Sibling of check-docs-drift.sh (#71).
#
# Canonical facts (must agree on every live surface below):
#   - 12 languages    (Konversa guest chat; NEVER "11 languages" again, PR #197)
#   - 15 runtime tools (11 federation + 2 host onboarding + 2 VRP verification)
#
# "11 languages" / "13 tools" have drifted onto Glama/Smithery before. This gate
# turns that drift into a build failure instead of a manual 5-surface re-check
# after every edit.
#
# SCOPE — only the live surfaces that feed agents/registries are checked.
# Historical records (docs/adr/**, docs/operations/** audit receipts) correctly
# say "13 tools" because that was true at the time; rewriting them would falsify
# history, so they are intentionally OUT of scope (same reason check-docs-drift
# uses a fixed file list rather than a repo-wide scan).
#
# Matching is PER-OCCURRENCE (grep -o), not per-line: a single packed line that
# legitimately says "15 runtime tools" AND wrongly says "13 runtime tools" still
# fails on the "13" — the canonical value elsewhere on the line does not mask it.
#
# NO false positives by construction:
#   * Only PLURAL "languages" / "språk" is a count claim. Singular "language" in
#     "ISO 639-1 language hint" / "BCP-47 language tag" is left alone.
#   * The tool TOTAL is matched only as "<N> runtime tools". The legitimate
#     sub-counts ("11 HemmaBo federation tools", "2 host onboarding tools",
#     "2 VRP verification tools") never say "runtime tools", so they pass.
#
# Exits 0 on clean, 1 on drift.

set -euo pipefail

# Live agent/human-facing surfaces that feed Glama / Smithery / MCP clients.
SURFACES=(
  "README.md"
  "llms.txt"
  "glama.json"
  "smithery.yaml"
  "package.json"
  "submission/chatgpt-app-submission.json"
  "lib/server-metadata.ts"
  "lib/host-onboarding.ts"
  "lib/tool-definitions.ts"
  "api/mcp-manifest.ts"
  "api/mcp.ts"
)

# Only scan surfaces that exist; warn (don't fail) if one is missing/renamed.
FILES=()
for f in "${SURFACES[@]}"; do
  if [[ -f "$f" ]]; then FILES+=("$f"); else echo "::warning::facts-drift: $f missing — skipping"; fi
done

drift=0

# check_rule <label> <find-regex> <canonical-number|""> <fix-hint>
# Flags every individual match of <find-regex> whose leading number != canonical.
# An empty canonical means the match is ALWAYS a violation (e.g. stale "13 tools").
check_rule() {
  local label="$1" find_re="$2" canon="$3" hint="$4"
  local hits
  hits=$(grep -noHE "$find_re" "${FILES[@]}" 2>/dev/null \
    | awk -v canon="$canon" '
        {
          mt = $0; sub(/^[^:]*:[^:]*:/, "", mt);   # strip file:line: prefix -> match text
          n = mt; gsub(/[^0-9].*$/, "", n);        # leading digits of the match
          if (canon == "" || n + 0 != canon + 0) print
        }' || true)
  if [[ -n "$hits" ]]; then
    echo "::error::facts-drift — $label:"
    echo "$hits"
    echo "  fix: $hint"
    echo ""
    drift=1
  fi
}

# 1. Language count must be 12 (plural "languages", space- or hyphen-joined).
check_rule "wrong language count (canonical: 12 languages)" \
  '\b[0-9]+[ -]languages\b' 12 \
  "use '12 languages' / '12-language' — see lib/server-metadata.ts, llms.txt, host-onboarding.ts"

# 2. Swedish language count must be 12 ("språk" / "olika språk").
check_rule "wrong language count in Swedish (canonical: 12 språk)" \
  '\b[0-9]+[ -](olika språk|språk)\b' 12 \
  "use '12 språk'"

# 3. Tool TOTAL must be 15 ("<N> runtime tools").
check_rule "wrong tool total (canonical: 15 runtime tools)" \
  '\b[0-9]+[ -]runtime tools\b' 15 \
  "use '15 runtime tools: 11 federation + 2 host onboarding + 2 VRP verification'"

# 4. Known stale tool totals as a bare "<N> tools" literal. 13/14 are never a
#    legitimate sub-count (those are 11 / 2 / 2), so flagging them is safe.
check_rule "stale tool total (the old wrong '13 tools' / '14 tools')" \
  '\b1[34][ -]tools\b' "" \
  "canonical total is 15 tools (15 runtime tools)"

if [[ $drift -ne 0 ]]; then
  echo "facts-drift check: FAILED — fix the counts above so every live surface agrees."
  echo "Canonical: 12 languages, 15 runtime tools."
  exit 1
fi

echo "facts-drift check: OK — 12 languages / 15 runtime tools consistent on all live surfaces."
