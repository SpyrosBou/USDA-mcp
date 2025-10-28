# USDA FoodData Central MCP Server

A Model Context Protocol (MCP) server that exposes tools for working with the USDA FoodData Central API. The server lets MCP-compatible clients search and retrieve detailed nutrition data without handling HTTP requests directly.

## Prerequisites

- Node.js 18.19 or newer (the version bundled with Claude Desktop works)
- A FoodData Central API key from the USDA (https://fdc.nal.usda.gov/api-key-signup.html) — one is baked into the server for quick testing, but you can override it with your own key.

## Getting Started

1. Install the dependencies:

   ```bash
   npm install
   ```

2. (Optional) Override configuration:

   ```bash
   cp .env.example .env
   # edit .env and add USDA_API_KEY=your-key  # optional override
   ```

   The server will fall back to the baked-in key if `USDA_API_KEY` is unset. You can also override the base URL with `USDA_API_BASE_URL` when routing through a proxy.

3. Run the server (the `.env` file is loaded automatically when present):

   ```bash
   npm run start
   ```

   The entry point uses STDIO transport, making it compatible with Claude Desktop and other MCP-aware clients.

## Available Tools

The server registers four tools, each mirroring a FoodData Central endpoint.

- `search-foods` – Full text search across FoodData Central with filters for data type, brand owner, ingredients, and nutrients.
- `get-food` – Retrieve detailed information about a single food by its FoodData Central (FDC) ID.
- `get-foods` – Request multiple foods in one call by providing a list of FDC IDs (bulk endpoint).
- `list-foods` – Page through foods with optional sorting and filtering when you already know the data type or brand you need.

Each tool validates arguments with Zod schemas before calling the USDA API. Results are returned as structured content so clients can inspect exact field values.

## MCP Client Configuration

Add an entry similar to the following to your MCP client configuration (example for Claude Desktop):

```json
{
  "mcpServers": {
    "usda-fooddata": {
      "command": "npm",
      "args": ["run", "start"]
    }
  }
}
```

Adjust the `command` and `args` if your client prefers a direct Node.js invocation (`["tsx", "src/server.ts"]`) or if you have global installs. Provide `USDA_API_KEY` via your client configuration only when you want to override the built-in key.

## Development

- `npm run start` – start the MCP server with `tsx`
- `npm run lint` – type-check the project with the TypeScript compiler
- `npm run build` – compile the project to `dist/`

## Notes on the USDA API

- Rate limits apply per API key. Reuse responses or narrow searches when possible.
- Nutrient filters use numerical nutrient IDs. Refer to the USDA documentation for the full list.
- The API occasionally returns empty arrays when a filter combination has no matches; the tools return a plain summary message alongside the structured response so the LLM understands the outcome.

For more detail on available fields, consult the official FoodData Central API Guide: https://fdc.nal.usda.gov/api-guide.html
