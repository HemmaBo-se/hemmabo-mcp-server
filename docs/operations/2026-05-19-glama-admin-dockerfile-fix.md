# Glama Admin Dockerfile Fix

Date: 2026-05-19
Scope: ADR 0004 Glama operational admin surface

## Observed Glama State

Glama admin showed:

- Last synced: `2026-05-19 17:09`
- Last commit: `3e2a182`
- Recent release: `0.1.0`
- Recent tests: failing
- Public tools still stale:
  - `search_properties`
  - `check_availability`
  - `get_canonical_quote`
  - `create_booking`
- Missing current ADR 0004 tool surface:
  - 13 tools
  - `verify_vacation_rental_node`
  - `get_verified_stay_offer`

## Root Cause

Glama's admin-generated Dockerfile was still starting:

```json
[
  "mcp-proxy",
  "--",
  "node",
  "dist/stdio.js"
]
```

That path is stale.

Since PR #107, the package bin and build output are:

```json
{
  "hemmabo-mcp-server": "dist/src/stdio.js"
}
```

Local verification:

- `dist/stdio.js`: missing
- `dist/src/stdio.js`: exists
- `npm.cmd run build`: passes

## Correct Glama Admin Dockerfile Settings

Use these values in Glama admin > Dockerfile.

### Build Steps

```json
[
  "npm ci",
  "npm run build"
]
```

### CMD Arguments

```json
[
  "mcp-proxy",
  "--",
  "node",
  "dist/src/stdio.js"
]
```

## Environment Variables Schema

Do not hardcode global user defaults such as:

- `propertyDomain`
- `language`
- `currency`

HemmaBo is global. Villa Akerlyckan is a reference proof node, not a Glama-wide default.

If Glama requires an environment-variable schema for local container tests, keep all fields optional.

The current optional schema is acceptable for local stdio packaging:

```json
{
  "properties": {
    "SUPABASE_SERVICE_ROLE_KEY": {
      "description": "The service role key for your Supabase project.",
      "type": "string"
    },
    "SUPABASE_URL": {
      "description": "The URL for your Supabase project.",
      "type": "string"
    }
  },
  "required": [],
  "type": "object"
}
```

Do not add secrets or defaults to Glama public configuration unless a later ADR explicitly changes this.

## Expected Result After Save/Test/Release

After saving the Dockerfile settings, run Glama's test/release flow on the existing HemmaBo server.

Expected public state:

- `HemmaBo + VRP, 13 tools, host-domain signed verified stay offers.`
- 13 tools
- 1 prompt
- includes `verify_vacation_rental_node`
- includes `get_verified_stay_offer`
- no old 4-tool surface
- no `check_availability`
- no `get_canonical_quote`
- no `dist/stdio.js`

Do not create a new Glama server listing.

