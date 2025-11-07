# USDA Rebuild Progress

_Updated: 2025-11-07 22:52 UTC_

Active dataset: 220 ingredients / 129 unique FDC IDs tracked through Codex CLI.

## Workflow for “No USDA equivalent” decisions

1. Use `search-foods` to confirm no SR Legacy or Foundation record covers the ingredient (or that only branded entries exist).
2. Capture the best fallback option (FDC ID + description) if you must rely on a branded entry, and note whether its macros are acceptable as-is.
3. When no acceptable record exists (composite spice blends, salt-inclusive rubs, etc.), mark the ingredient as “No USDA equivalent” in the table below together with the manual macro source.
4. Reference this file before future validation runs so repeated lookups are skipped intentionally. Update or remove rows as soon as USDA publishes a suitable record.

## Known outliers

| Ingredient / Blend | Status | Guidance | Last reviewed |
| --- | --- | --- | --- |
| Ground sumac | Canonical entry (branded) | Use FDC 2630657. Record any downstream adjustments, but treat this branded record as the source of truth until USDA adds a generic counterpart. | 2025-11-07 |
| Mixed salt + pepper blends | No USDA equivalent | Keep manual macros sourced from internal formulation docs; note any sodium adjustments when sharing totals downstream. | 2025-11-07 |

Add new rows (alphabetically) whenever you discover additional gaps, and keep the “Last reviewed” column current so we know when to revisit an entry.
