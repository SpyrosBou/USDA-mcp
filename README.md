# USDA FoodData Central MCP Server

Model Context Protocol (MCP) server that exposes USDA FoodData Central search and lookup tools. Plug it into Codex CLI, Claude Desktop, or any MCP-aware client to explore nutrition data without writing HTTP calls by hand.

_Last README sync: base commit `d3a3fa1` (update after next commit)._ 

---

## Highlights

- **Four ready-to-use tools** wrapping FoodData Central search, single-record lookup, bulk lookup, and paginated listing.
- **Strict validation** with Zod schemas for inputs and outputs so LLMs can rely on structured results.
- **Cursor-aware previews** let you dry-run calls, request compact summaries, and opt into raw payloads only when needed.
- **Lean nutrient lookups** surface per-100 g calories, macros, saturated fat, and fiber through focused tools that accept just an FDC ID.
- **Resilient HTTP client** with throttling, timeouts, and exponential backoff retries for USDA rate limits.
- **Built-in environment resource** that describes the server configuration from inside your MCP client.

---

## Requirements

- Node.js 18.19 or newer (Claude Desktop’s bundled Node works).
- USDA FoodData Central API key — request one at https://fdc.nal.usda.gov/api-key-signup.html and provide it via `USDA_API_KEY`.

---

## Quick Start

```bash
git clone <repo-url>
cd USDA-mcp
npm install

cp .env.example .env
echo "USDA_API_KEY=your-key" >> .env

npm run start   # runs via tsx with stdio transport
```

The server exits immediately if `USDA_API_KEY` is missing or blank. When you hand the server off to an MCP client, have that client supply the variable instead of relying on `.env`.

To run the compiled CLI (needed for Codex autostart):

```bash
npm run build
npx usda-mcp            # assumes USDA_API_KEY is exported or supplied by the client
# Optional: install the CLI globally so `usda-mcp` is on your PATH
# npm install --global .
# (or run `npm link` inside the repo)
```

---

## Configuration

Environment variables read at startup:

| Variable            | Required | Default | Purpose                                                                     |
| ------------------- | -------- | ------- | --------------------------------------------------------------------------- |
| `USDA_API_KEY`      | Yes      | —       | FoodData Central API key; server exits if unset.                            |
| `USDA_API_BASE_URL` | No       | `https://api.nal.usda.gov/fdc/v1/` | Override when routing through a proxy or staging host. |

You can provide these through `.env`, your shell, or the MCP client configuration. Use the `config://usda-fooddata/environment` resource to inspect the active settings from inside the client.

---

## Running Under MCP Clients

Most MCP clients let you attach environment variables directly to a server definition. Provide `USDA_API_KEY` there so the USDA server runs regardless of your working directory. Only set `USDA_API_BASE_URL` when you need to hit a non-default endpoint.

### Codex CLI (`~/.config/codex/config.toml`)

Codex profiles accept per-server environment variables in TOML ([Codex configuration guide](https://github.com/openai/codex/blob/main/docs/config.md)).

Use whichever `command` style matches your setup:

- `command = "usda-mcp"` if you ran `npm install --global .` (or `npm link`) so the CLI is on your `PATH`.
- `command = "node"` with `args = ["/absolute/path/to/dist/server.js"]` if you prefer not to install the package globally.

```toml
experimental_use_rmcp_client = true

[mcp_servers.usda_fooddata]
command = "usda-mcp"
startup_timeout_sec = 20
tool_timeout_sec = 60
# If the CLI is not on your PATH:
# command = "node"
# args = ["/Users/you/projects/USDA-mcp/dist/server.js"]

[mcp_servers.usda_fooddata.env]
USDA_API_KEY = "your-fooddata-central-key"
# Optional override if you proxy the API:
# USDA_API_BASE_URL = "https://api.nal.usda.gov/fdc/v1/"
```

### Claude Desktop (`claude_desktop_config.json`)

Claude Desktop reads server definitions from `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS (see the [MCP introductory docs](https://modelcontextprotocol.io/modelcontextprotocol/typescript-sdk/refs/heads/main/README) for the format). Point to your built entry point and inject the key via `env`.

```jsonc
{
  "mcpServers": {
    "usda": {
      "command": "node",
      "args": ["/Users/you/projects/USDA-mcp/dist/server.js"],
      "env": {
        "USDA_API_KEY": "your-fooddata-central-key"
        // "USDA_API_BASE_URL": "https://api.nal.usda.gov/fdc/v1/"
      }
    }
  }
}
```

Re-run `npm run build` whenever you change the server so `dist/server.js` stays in sync.

### Cursor IDE (`~/.cursor/mcp.json`)

Cursor keeps MCP definitions in `~/.cursor/mcp.json`. Any server listed under `mcpServers` can set `env` (many server READMEs, including [Yandex Search](https://github.com/yandex/yandex-search-mcp-server/blob/main/readme.md), use the same layout).

```jsonc
{
  "mcpServers": {
    "usda-fooddata": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/you/projects/USDA-mcp/dist/server.js"],
      "env": {
        "USDA_API_KEY": "your-fooddata-central-key"
      },
      "startupTimeoutMs": 20000,
      "toolTimeoutMs": 60000
    }
  }
}
```

### Claude Code (`settings.json`)

```jsonc
{
  "mcpServers": {
    "usda-fooddata": {
      "command": "node",
      "args": ["/Users/you/projects/USDA-mcp/dist/server.js"],
      "env": {
        "USDA_API_KEY": "your-fooddata-central-key"
      },
      "timeout": 20000
    }
  }
}
```

### Gemini CLI (`settings.json`)

Gemini CLI merges MCP servers from system, user, and workspace settings ([Gemini CLI configuration](https://geminicli.com/docs/get-started/configuration-v1)).

```jsonc
{
  "mcpServers": {
    "usda-fooddata": {
      "command": "node",
      "args": ["/Users/you/projects/USDA-mcp/dist/server.js"],
      "env": {
        "USDA_API_KEY": "your-fooddata-central-key"
      },
      "timeout": 30000
    }
  },
  "mcp": {
    "allowed": ["usda-fooddata"]
  }
}
```

---

## Tools

All tools return a plain-text summary plus a `structuredContent` payload with a `summary` object, compact `previews`, and (when requested) the raw USDA response. Use the preview and dry-run switches to conserve context until you know you need the full payload.

- `search-foods` – Full-text search that only surfaces the food description, optional brand/data type, and `fdcId` so agents can pick an entry without excessive detail. Filters, cursor pagination, sort controls, and dry-run previews help shrink context impact.
- `get-food` – Fetch a single FoodData Central (FDC) record by ID with optional `format` and `nutrients` filters. Requests default to the faster USDA “abridged” view; the summary highlights macros (when present) and any notable gaps in the response. When USDA retires a known legacy identifier (e.g., SR Legacy 4053 for olive oil), the tool automatically substitutes the documented replacement (Foundation 748608 in this case) and adds a note so you know why the ID changed.
- `get_macros` – Return per-100 g calories, protein, fat, and carbohydrates for a single FDC entry with structured nutrient metadata. The helper first issues an abridged request scoped to the macro nutrient IDs, escalates to `format=full`, retries again without any nutrient filter, and finally consults `labelNutrients`. If a Foundation record still withholds even one macro after that sequence, the tool now errors with guidance so you can pick a different FDC entry or compute the numbers manually (e.g., 1 g fat ≈ 9 kcal).
- `get_fats`, `get_protein`, `get_carbs`, `get_kcal`, `get_satfats`, `get_fiber` – Single-nutrient lookups that emit just the requested per-100 g value (or note that it is unavailable) to keep tool output distinct.
- `get-foods` – Bulk lookup for up to 50 FDC IDs in one call. Supports `previewOnly`, `includeRaw`, `sampleSize`, and `estimateOnly` so you can review lightweight previews before retrieving the full objects, defaults to the faster USDA “abridged” format, and flags any requested IDs the USDA API omits. Known legacy → replacement mappings (e.g., 4053 → 748608) are applied automatically and noted in the summary.
- `list-foods` – Deterministic paginated listing that accepts optional `filters` (data types, brand owner), cursor-based `pagination`, `sort`, and the same preview/dry-run switches as `search-foods`. The summary returns the next cursor only when another page is likely available.

### Handling Foundation entries without USDA macros

Foundation datasets sometimes omit energy, protein, or carbohydrate rows entirely (pure oils often only list lipid chemistry). The macro helper therefore:

1. Requests the abridged payload scoped to the calorie/protein/fat/carbohydrate nutrient IDs.
2. Falls back to `format=full` so USDA can include “analysis only” nutrients.
3. Retries the abridged call without nutrient filters so the API can decide which nutrients to include.
4. Reads `labelNutrients` when present.

If any macro is still missing *and* the entry’s `dataType` is `Foundation`, `get_macros` stops with an error that lists the missing fields and suggests either switching to a record that publishes macros (e.g., SR Legacy or Survey entries) or deriving them yourself. A quick rule of thumb: calories ≈ `(fat_g * 9) + (protein_g * 4) + (carbs_g * 4)`. For the current olive-oil replacement (FDC 748608), USDA only publishes fat, so macros must be inferred externally.

---

## Resources

- **`config://usda-fooddata/environment`** – Markdown overview showing the active base URL, whether a key is detected, retry/throttle policies, and guidance for overrides.

---

## Operational Notes

- Requests time out after 30 seconds, use up to two retries with jittered exponential backoff on HTTP 429 or 5xx, and throttle to one concurrent call with ≥400 ms spacing so we stay under the 3 requests/second USDA ceiling. When USDA asks for a longer pause (via `Retry-After`), that guidance is surfaced in the error text.
- Handle USDA rate limits responsibly: use narrow filters, reuse previous results, and avoid large bulk queries unless necessary.
- Missing or invalid API keys cause the server to log the issue and exit immediately so MCP clients can surface the error.
- Nutrient helpers follow a strict escalation path (scoped abridged → `format=full` → unfiltered abridged → `labelNutrients`) and recognise alternate labels such as `Total fat (NLEA)` so oils and other sparse entries still return macro values. When a Foundation record still hides any macro after those retries, `get_macros` intentionally errors and points you to alternate FDC IDs or the calorie conversion formula so downstream automations do not ingest partial data unknowingly.
- Legacy SR Legacy identifiers that USDA has retired (currently 4053 for olive oil) are automatically mapped to their documented replacement IDs, and every substitution is called out in the tool summaries (plus `requestedFdcIds` in the preview payload) so downstream automations can update their catalogs.

---

## Development Workflow

- `npm run start` – Launch with `tsx` for local development.
- `npm run lint` – Type-check the TypeScript sources (`tsc --noEmit`).
- `npm run build` – Emit the compiled bundle to `dist/` for the CLI or packaging.

Run `npm run build` whenever you change server code and want Codex or other clients that call `usda-mcp` to pick up the new build.

---

## Troubleshooting

- **Startup fails: missing API key** – Ensure `USDA_API_KEY` is exported in your shell or supplied through the MCP client config.
- **Client connects but requests fail with 401/403** – Verify the key is active and not rate-limited on the USDA side.
- **Repeated 429 Too Many Requests** – Each tool already slows calls to one at a time; if you still get 429 responses, wait for the `Retry-After` duration shown in the error text or batch IDs into fewer round-trips.
- **Legacy FDC ID returns “not found”** – USDA periodically retires SR Legacy entries. Known substitutions (currently 4053 → 748608 for olive oil) are applied automatically and annotated in the tool response; otherwise, use `search-foods` to locate the modern FDC ID.
- **Foundation macros come back empty** – `get_macros` escalates through full/unfiltered calls plus `labelNutrients`. When a Foundation record still lacks macros, the tool now errors with the missing fields listed. Pick another FDC ID that exposes macros (SR Legacy or Survey datasets usually do) or estimate the calories via `(fat_g * 9) + (protein_g * 4) + (carbs_g * 4)` (oils generally have protein/carbs = 0).
- **CLI warns about missing `dist/server.js`** – Run `npm run build` before invoking `npx usda-mcp`.

For API reference, see the official FoodData Central guide: https://fdc.nal.usda.gov/api-guide.html
