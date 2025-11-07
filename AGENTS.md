# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains TypeScript sources: `src/server.ts` (entry point), `src/usdaClient.ts` (API client), and `src/config.ts` (environment defaults).
- `dist/` stores build artifacts from `npm run build`; never edit them directly.
- Keep `README.md` and this guide aligned with behavior changes, and use `.env.example` as the template without committing `.env`.

## Build, Test, and Development Commands
- `npm install` – install dependencies; run this whenever `package.json` changes.
- `npm run start` – launch the MCP server via `tsx` for local development or Claude Desktop integration.
- `npm run lint` – execute `tsc --noEmit` to surface type errors before review.
- `npm run build` – transpile the project into `dist/` for distribution or packaging.
- `npm run usda` – run the compiled server to validate the build output matches expectations.

## Coding Style & Naming Conventions
- Write TypeScript with ECMAScript modules, two-space indentation, and no trailing whitespace.
- Keep files single-purpose and prefer named exports: transport logic in `src/server.ts`, HTTP orchestration in `src/usdaClient.ts`, configuration helpers in `src/config.ts`.
- Use `camelCase` for variables and functions, `PascalCase` for types and classes, uppercase snake case for environment constants, and mirror USDA API shapes with matching `zod` schemas.

## Testing Guidelines
- No automated suite is in place; outline your testing approach in the PR (pull request) and add coverage when feasible.
- Prefer the built-in `node:test` module or `vitest` for new suites; co-locate specs as `<module>.spec.ts` beside the source.
- When mocking USDA responses, store fixtures under `__fixtures__/` and cover both textual summaries and `structuredContent`.
- Run `npm run lint` before review and treat type-check failures as blocking issues.

## Commit & Pull Request Guidelines
- Follow Conventional Commits (`feat:`, `fix:`, `docs:`, etc.) and keep each commit scoped to one concern.
- Include PR context, testing performed, and configuration notes; link issues or tickets when applicable.
- Highlight documentation or configuration updates, and add screenshots only when the observable output changes.
- Seek at least one maintainer review before merging and flag any breaking behavior changes in both the description and commit message.

## Configuration Notes
- Never commit `.env`; manage secrets via environment variables or workspace overrides.
- `USDA_API_KEY` is mandatory—ensure documentation stays aligned whenever the acquisition flow changes and update `src/config.ts`, this guide, and `README.md` if additional requirements appear.
- `config://usda-fooddata/environment` exposes configuration and operational guidance as a read-only MCP resource—keep it accurate when defaults change.
- Track ingredient coverage decisions in `usda_rebuild_progress.md`. Log every “no USDA equivalent” call (e.g., ground sumac currently only has branded ID 2630657, composite salt+pepper blends stay manual) so contributors can skip redundant lookups and know which macros come from internal formulations.
- USDA requests are throttled (1 concurrent call, ≥400 ms spacing) with up to two retries on HTTP 429/5xx or timeouts; adjust documentation and the `config://usda-fooddata/environment` resource if these limits move.
- Keep sample configuration minimal so contributors can validate locally without exposing private keys.
- Tool responses surface a `summary` block, `previews`, and optional raw payloads. Update the Zod schemas, documentation, and helper metadata together whenever tool arguments or output fields change.
- Tools currently exposed: `search-foods`, `get-food`, `get-foods`, `list-foods`, `get_macros`, and the single-nutrient helpers `get_fats`, `get_protein`, `get_carbs`, `get_kcal`, `get_satfats`, `get_fiber`. Keep this list current when adding or removing capabilities, and document behavioural changes (e.g., new aliases or validation rules) in both this guide and the README immediately.
- `get_macros` escalates through abridged, full, and unfiltered nutrient pulls and now inspects Foundation label keys such as `Energy (kcal)` or `Total fat (NLEA)` before throwing a descriptive error when a record still omits any macro. Anytime the guard or retry order changes, update README troubleshooting guidance and note the conversion formula (fat × 9 + protein/carbs × 4) for manual derivations.
