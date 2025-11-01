# USDA FoodData Central MCP Server

Model Context Protocol (MCP) server that exposes USDA FoodData Central search and lookup tools. Plug it into Codex CLI, Claude Desktop, or any MCP-aware client to explore nutrition data without writing HTTP calls by hand.

---

## Highlights

- **Four ready-to-use tools** wrapping FoodData Central search, single-record lookup, bulk lookup, and paginated listing.
- **Strict validation** with Zod schemas for inputs and outputs so LLMs can rely on structured results.
- **Cursor-aware previews** let you dry-run calls, request compact summaries, and opt into raw payloads only when needed.
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

The server exits immediately if `USDA_API_KEY` is missing or blank. When running under an MCP client, configure the variable through the client instead of using `.env`.

To run the compiled CLI (needed for Codex autostart):

```bash
npm run build
npx usda-mcp            # assumes USDA_API_KEY is exported or supplied by the client
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

## MCP Client Configuration Templates

```toml
# Codex CLI (~/.config/codex/config.toml)
experimental_use_rmcp_client = true

[mcp_servers.usda_fooddata]
command = "usda-mcp"
startup_timeout_sec = 20
tool_timeout_sec = 60

[mcp_servers.usda_fooddata.env]
USDA_API_KEY = "your-fooddata-central-key"
# Optional: env.USDA_API_BASE_URL = "https://api.nal.usda.gov/fdc/v1/"
```

```jsonc
// Claude Desktop (settings.json)
{
  "mcpServers": {
    "usda-fooddata": {
      "command": "npm",
      "args": ["run", "start"],
      "env": {
        "USDA_API_KEY": "your-fooddata-central-key"
      }
    }
  }
}
```

```jsonc
// Cursor IDE (~/.cursor/mcp.json)
{
  "mcpServers": {
    "usda-fooddata": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/Users/warui1/projects/USDA-mcp",
      "env": {
        "USDA_API_KEY": "your-fooddata-central-key"
      },
      "startupTimeoutMs": 20000,
      "toolTimeoutMs": 60000
    }
  }
}
```

```jsonc
// Claude Code (settings.json)
{
  "mcpServers": {
    "usda-fooddata": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/Users/warui1/projects/USDA-mcp",
      "env": {
        "USDA_API_KEY": "your-fooddata-central-key"
      },
      "timeout": 20000
    }
  }
}
```

```jsonc
// Gemini CLI (user settings.json)
{
  "mcpServers": {
    "usda-fooddata": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/Users/warui1/projects/USDA-mcp",
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

- **`search-foods`** – Full-text search with nested `filters` (`dataTypes`, `brandOwner`, `ingredients`, `nutrientIds`, `requireAllWords`), cursor-friendly `pagination` (`page`/`size`/`cursor`), and `sort` controls. Toggle `previewOnly`, `includeRaw`, `sampleSize`, or `estimateOnly` to switch between dry-run estimates, compact previews, and full result sets. `structuredContent.summary` reports `totalHits`, `nextCursor`, and context warnings when the payload is large.
- **`get-food`** – Fetch a single FoodData Central (FDC) record by ID with optional `format` and `nutrients` filters. The summary highlights macros (when present) and any notable gaps in the response.
- **`get-foods`** – Bulk lookup for up to 50 FDC IDs in one call. Supports `previewOnly`, `includeRaw`, `sampleSize`, and `estimateOnly` so you can review lightweight previews before retrieving the full objects.
- **`list-foods`** – Deterministic paginated listing that accepts optional `filters` (data types, brand owner), cursor-based `pagination`, `sort`, and the same preview/dry-run switches as `search-foods`. The summary returns the next cursor only when another page is likely available.

---

## Resources

- **`config://usda-fooddata/environment`** – Markdown overview showing the active base URL, whether a key is detected, retry/throttle policies, and guidance for overrides.

---

## Operational Notes

- Requests time out after 30 seconds, use up to two retries with jittered exponential backoff on HTTP 429 or 5xx, and throttle to two concurrent calls with ≥250 ms spacing.
- Handle USDA rate limits responsibly: use narrow filters, reuse previous results, and avoid large bulk queries unless necessary.
- Missing or invalid API keys cause the server to log the issue and exit immediately so MCP clients can surface the error.

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
- **CLI warns about missing `dist/server.js`** – Run `npm run build` before invoking `npx usda-mcp`.

For API reference, see the official FoodData Central guide: https://fdc.nal.usda.gov/api-guide.html
