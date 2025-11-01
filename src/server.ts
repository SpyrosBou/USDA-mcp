import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z, type ZodRawShape } from 'zod';

import {
  FoodDataCentralClient,
  FoodItem,
  FoodQueryOptions,
  ListFoodsRequest,
  SearchFoodsRequest,
  SearchFoodsResponse
} from './usdaClient.js';
import { describeEnvironmentOverride, USDA_API_BASE_URL } from './config.js';

const serverInstructions = [
  'Provides USDA FoodData Central search and lookup tools.',
  'Requires USDA_API_KEY to be set in the environment (e.g., via MCP config env.USDA_API_KEY) before startup.',
  'Respect USDA rate limits by filtering queries and batching lookups.',
  'Expect structuredContent payloads for reliable downstream parsing.'
].join('\n');

const server = new McpServer(
  {
    name: 'usda-fooddata-central',
    version: '0.2.0'
  },
  {
    instructions: serverInstructions
  }
);

server.server.registerCapabilities({
  logging: {},
  tools: {
    listChanged: true
  }
});

let client: FoodDataCentralClient;

try {
  client = new FoodDataCentralClient({
    logger: (message) => {
      void server.sendLoggingMessage({
        level: 'info',
        logger: 'usda-fooddata-central',
        data: message
      });
    }
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Failed to initialize USDA FoodData Central client.');
  console.error(message);
  process.exit(1);
}

const foodDataTypeSchema = z
  .enum(['Branded', 'Survey (FNDDS)', 'SR Legacy', 'Foundation', 'Experimental'])
  .describe('FoodData Central data type filter.');

const nutrientIdsSchema = z
  .array(z.number().int().positive())
  .min(1)
  .max(25)
  .describe('List of nutrient IDs to include (per API documentation).');

const macroSummaryShape = {
  calories: z.number().optional(),
  protein: z.number().optional(),
  fat: z.number().optional(),
  carbs: z.number().optional()
} satisfies ZodRawShape;

const macroSummarySchema = z.object(macroSummaryShape).strict();

const foodItemSchema = z.record(z.string(), z.unknown());

const MAX_PAGE_SIZE = 200;
const DEFAULT_SEARCH_PAGE_SIZE = 25;
const DEFAULT_LIST_PAGE_SIZE = 50;
const DEFAULT_PREVIEW_SAMPLE_SIZE = 8;
const MAX_PREVIEW_SAMPLE_SIZE = 25;
const CONTEXT_WARNING_THRESHOLD_BYTES = 40_000;

type CursorTool = 'search-foods' | 'list-foods';

type CursorDetails = {
  page: number;
  size: number;
};

const DEFAULT_CURSOR_SIZES: Record<CursorTool, number> = {
  'search-foods': DEFAULT_SEARCH_PAGE_SIZE,
  'list-foods': DEFAULT_LIST_PAGE_SIZE
};

const searchPreviewShape = {
  fdcId: z.number(),
  description: z.string(),
  dataType: z.string().optional(),
  brandOwner: z.string().optional()
} satisfies ZodRawShape;

const searchPreviewSchema = z.object(searchPreviewShape).strict();

const foodSummaryShape = {
  description: z.string(),
  fdcId: z.number().optional(),
  dataType: z.string().optional(),
  brandOwner: z.string().optional(),
  publishedDate: z.string().optional(),
  macros: macroSummarySchema.optional()
} satisfies ZodRawShape;

const foodSummarySchema = z.object(foodSummaryShape).strict();

const paginationOptionsSchema = z
  .object({
    page: z.number().int().min(1).max(200).optional(),
    size: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).optional()
  })
  .strict()
  .partial()
  .describe('Pagination controls. Provide either page/size or cursor, not both.');

const searchFilterSchema = z
  .object({
    dataTypes: z.array(foodDataTypeSchema).max(5).optional(),
    brandOwner: z.string().min(1).optional(),
    ingredients: z.string().min(1).optional(),
    nutrientIds: nutrientIdsSchema.optional(),
    requireAllWords: z.boolean().optional()
  })
  .strict()
  .partial()
  .describe('Optional filters to narrow the search results.');

const searchSortSchema = z
  .object({
    by: z.enum(['relevance', 'dataType.keyword', 'lowercaseDescription.keyword', 'publishedDate']).optional(),
    direction: z.enum(['asc', 'desc']).optional()
  })
  .strict()
  .partial()
  .describe('Sort configuration. Omit or set by="relevance" for API defaults.');

const listFilterSchema = z
  .object({
    dataTypes: z.array(foodDataTypeSchema).max(5).optional(),
    brandOwner: z.string().min(1).optional()
  })
  .strict()
  .partial()
  .describe('Optional filters to scope the deterministic listing endpoint.');

const listSortSchema = z
  .object({
    by: z.enum(['dataType.keyword', 'lowercaseDescription.keyword', 'publishedDate']).optional(),
    direction: z.enum(['asc', 'desc']).optional()
  })
  .strict()
  .partial()
  .describe('Sort configuration for listing results.');

const searchFoodsInputShape = {
  query: z.string().min(1, 'Query is required'),
  filters: searchFilterSchema.optional(),
  pagination: paginationOptionsSchema.optional(),
  sort: searchSortSchema.optional(),
  previewOnly: z.boolean().optional(),
  includeRaw: z.boolean().optional(),
  sampleSize: z.number().int().min(1).max(MAX_PREVIEW_SAMPLE_SIZE).optional(),
  estimateOnly: z.boolean().optional()
} satisfies ZodRawShape;

const listFoodsInputShape = {
  filters: listFilterSchema.optional(),
  pagination: paginationOptionsSchema.optional(),
  sort: listSortSchema.optional(),
  previewOnly: z.boolean().optional(),
  includeRaw: z.boolean().optional(),
  sampleSize: z.number().int().min(1).max(MAX_PREVIEW_SAMPLE_SIZE).optional(),
  estimateOnly: z.boolean().optional()
} satisfies ZodRawShape;

const searchFoodsOutputShape = {
  summary: z
    .object({
      query: z.string(),
      totalHits: z.number().min(0),
      returned: z.number().min(0),
      page: z.number().int().min(1),
      pageSize: z.number().int().min(1),
      totalPages: z.number().int().min(0),
      nextCursor: z.string().optional(),
      dryRun: z.boolean().optional(),
      notes: z.array(z.string()).optional()
    })
    .strict(),
  previews: z.array(searchPreviewSchema),
  raw: z
    .object({
      foods: z.array(foodItemSchema),
      totalHits: z.number(),
      currentPage: z.number(),
      totalPages: z.number(),
      pageList: z.array(z.number())
    })
    .passthrough()
    .optional()
} satisfies ZodRawShape;

const getFoodOutputShape = {
  summary: z
    .object({
      fdcId: z.number(),
      description: z.string(),
      macros: macroSummarySchema.optional(),
      notes: z.array(z.string()).optional()
    })
    .strict(),
  food: foodItemSchema,
  macros: macroSummarySchema.optional()
} satisfies ZodRawShape;

const bulkFoodsOutputShape = {
  summary: z
    .object({
      requested: z.number().int().min(1),
      returned: z.number().int().min(0),
      previewOnly: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      notes: z.array(z.string()).optional()
    })
    .strict(),
  previews: z.array(foodSummarySchema),
  foods: z.array(foodItemSchema).optional()
} satisfies ZodRawShape;

const listFoodsOutputShape = {
  summary: z
    .object({
      page: z.number().int().min(1),
      pageSize: z.number().int().min(1),
      returned: z.number().int().min(0),
      requestedFilters: listFilterSchema.optional(),
      nextCursor: z.string().optional(),
      dryRun: z.boolean().optional(),
      previewOnly: z.boolean().optional(),
      notes: z.array(z.string()).optional()
    })
    .strict(),
  previews: z.array(foodSummarySchema),
  foods: z.array(foodItemSchema).optional()
} satisfies ZodRawShape;

const NUTRIENT_KEYS = ['calories', 'protein', 'fat', 'carbs', 'saturatedFat', 'fiber'] as const;

type NutrientKey = (typeof NUTRIENT_KEYS)[number];

type NutrientDefinition = {
  key: NutrientKey;
  label: string;
  unit: 'g' | 'kcal';
  ids: ReadonlySet<number>;
  names: ReadonlySet<string>;
};

const NUTRIENT_DEFINITIONS: Record<NutrientKey, NutrientDefinition> = {
  calories: {
    key: 'calories',
    label: 'Calories',
    unit: 'kcal',
    ids: new Set([1008, 208]),
    names: new Set(['energy', 'energy (atwater general factors)'].map((value) => value.toLowerCase()))
  },
  protein: {
    key: 'protein',
    label: 'Protein',
    unit: 'g',
    ids: new Set([1003, 203]),
    names: new Set(['protein'].map((value) => value.toLowerCase()))
  },
  fat: {
    key: 'fat',
    label: 'Total fat',
    unit: 'g',
    ids: new Set([1004, 204]),
    names: new Set(['total lipid (fat)', 'total fat'].map((value) => value.toLowerCase()))
  },
  carbs: {
    key: 'carbs',
    label: 'Carbohydrates',
    unit: 'g',
    ids: new Set([1005, 205]),
    names: new Set(['carbohydrate, by difference', 'carbohydrates'].map((value) => value.toLowerCase()))
  },
  saturatedFat: {
    key: 'saturatedFat',
    label: 'Saturated fat',
    unit: 'g',
    ids: new Set([1258, 606]),
    names: new Set(['fatty acids, total saturated', 'saturated fat'].map((value) => value.toLowerCase()))
  },
  fiber: {
    key: 'fiber',
    label: 'Dietary fiber',
    unit: 'g',
    ids: new Set([1079, 291]),
    names: new Set(['fiber, total dietary', 'dietary fiber'].map((value) => value.toLowerCase()))
  }
};

const nutrientValueSchema = z
  .object({
    key: z.enum(NUTRIENT_KEYS),
    label: z.string(),
    unit: z.enum(['g', 'kcal']),
    valuePer100g: z.number().nonnegative().optional(),
    sourceNutrientId: z.number().optional()
  })
  .strict();

const singleNutrientOutputShape = {
  summary: z
    .object({
      fdcId: z.number(),
      description: z.string(),
      notes: z.array(z.string()).optional()
    })
    .strict(),
  nutrient: nutrientValueSchema
} satisfies ZodRawShape;

const macroOnlyOutputShape = {
  summary: z
    .object({
      fdcId: z.number(),
      description: z.string(),
      notes: z.array(z.string()).optional()
    })
    .strict(),
  nutrients: z.array(nutrientValueSchema)
} satisfies ZodRawShape;

server.registerTool(
  'search-foods',
  {
    title: 'Search Foods',
    description:
      'Full-text search of USDA FoodData Central with structured filters, pagination cursors, preview mode, and dry-run estimation to conserve context.',
    annotations: {
      readOnlyHint: true,
      openWorldHint: true
    },
    inputSchema: searchFoodsInputShape,
    outputSchema: searchFoodsOutputShape,
    _meta: {
      version: '2025-07-01',
      defaultPageSize: DEFAULT_SEARCH_PAGE_SIZE,
      supportsCursor: true,
      supportsPreview: true,
      supportsDryRun: true,
      rateLimitPolicy: '≤2 concurrent USDA calls, ≥250ms spacing, 2 retries'
    }
  },
  async (input) => {
    const previewOnly = input.previewOnly ?? false;
    const includeRaw = input.includeRaw ?? false;
    const sampleSize = clampSampleSize(input.sampleSize);
    const estimateOnly = input.estimateOnly ?? false;

    const filters = input.filters ?? {};
    const pagination = input.pagination ?? {};
    const sort = input.sort ?? {};

    let cursorPayload: CursorDetails | undefined;
    if (pagination.cursor) {
      if (pagination.page !== undefined || pagination.size !== undefined) {
        throw new Error('Provide either pagination.cursor or pagination.page/pagination.size, not both.');
      }
      cursorPayload = decodeCursor(pagination.cursor, 'search-foods');
    }

    const rawPageNumber = cursorPayload?.page ?? pagination.page ?? 1;
    const rawPageSize = cursorPayload?.size ?? pagination.size ?? DEFAULT_SEARCH_PAGE_SIZE;
    const pageNumber = Math.max(1, Math.trunc(rawPageNumber));
    const pageSize = Math.min(Math.max(Math.trunc(rawPageSize), 1), MAX_PAGE_SIZE);

    if (estimateOnly) {
      const notes = [
        'Dry-run mode: no USDA request sent.',
        `Would request page ${pageNumber} with page size ${pageSize}.`
      ];
      const summary = {
        query: input.query,
        totalHits: 0,
        returned: 0,
        page: pageNumber,
        pageSize,
        totalPages: 0,
        dryRun: true,
        notes
      };
      return {
        content: [
          {
            type: 'text',
            text: `Dry run: search "${input.query}" would request page ${pageNumber} (size ${pageSize}).`
          }
        ],
        structuredContent: {
          summary,
          previews: []
        }
      };
    }

    const params: SearchFoodsRequest = {
      query: input.query,
      dataType: filters.dataTypes,
      brandOwner: filters.brandOwner,
      ingredients: filters.ingredients,
      nutrients: filters.nutrientIds,
      requireAllWords: filters.requireAllWords,
      pageNumber,
      pageSize,
      sortBy: sort.by && sort.by !== 'relevance' ? sort.by : undefined,
      sortOrder: sort.direction
    };

    const results = await client.searchFoods(params);
    const allPreviews = results.foods.map((food) => toSearchPreview(food));
    const limitedPreviews = allPreviews.slice(0, sampleSize);

    const nextCursor =
      results.currentPage < results.totalPages
        ? encodeCursor('search-foods', results.currentPage + 1, pageSize)
        : undefined;

    const notes: string[] = [];
    if (previewOnly) {
      notes.push(`Preview mode enabled; returning top ${limitedPreviews.length} matches.`);
    }
    if (!includeRaw) {
      notes.push('Raw USDA payload omitted to conserve context. Set includeRaw=true to include it.');
    }

    let rawPayload: SearchFoodsResponse | undefined;
    if (includeRaw) {
      rawPayload = results;
      const approxBytes = estimateResultSize(rawPayload);
      if (approxBytes > CONTEXT_WARNING_THRESHOLD_BYTES) {
        notes.push(
          `Raw payload ≈ ${approxBytes.toLocaleString()} bytes; consider previewOnly=true or includeRaw=false to reduce context usage.`
        );
      }
    }

    const previewCount = limitedPreviews.length;
    const rawCount = results.foods.length;
    const returnedCount = includeRaw ? rawCount : previewCount;

    const summary = {
      query: input.query,
      totalHits: results.totalHits,
      returned: returnedCount,
      page: results.currentPage,
      pageSize,
      totalPages: results.totalPages,
      ...(nextCursor ? { nextCursor } : {}),
      ...(notes.length ? { notes } : {})
    };

    const lines = [
      `Search "${input.query}" matched ${results.totalHits} foods.`,
      `Page ${results.currentPage} of ${results.totalPages} (size ${pageSize}).`,
      previewOnly
        ? `Previewing ${previewCount} items; set previewOnly=false and includeRaw=true for full page details.`
        : includeRaw
          ? `Returned ${rawCount} items this page.`
          : `Returned ${previewCount} preview items; set includeRaw=true to fetch the full page.`,
      nextCursor ? 'Next cursor available in structuredContent.summary.nextCursor.' : undefined
    ].filter((line): line is string => Boolean(line));

    return {
      content: [
        {
          type: 'text',
          text: lines.join('\n')
        }
      ],
      structuredContent: {
        summary,
        previews: limitedPreviews,
        ...(rawPayload ? { raw: rawPayload } : {})
      }
    };
  }
);

server.registerTool(
  'get-food',
  {
    title: 'Get Food Details',
    description:
      'Look up a single FoodData Central (FDC) record by numeric ID. Supports abridged/full detail toggles and nutrient ID subsets to trim responses. Ideal once you already know the identifier.',
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      idempotentHint: true
    },
    inputSchema: {
      fdcId: z.number().int().positive(),
      format: z.enum(['abridged', 'full']).optional(),
      nutrients: nutrientIdsSchema.optional()
    },
    outputSchema: getFoodOutputShape,
    _meta: {
      version: '2025-07-01',
      expectedLatencyMs: 750,
      supportsPreview: false,
      supportsDryRun: false,
      rateLimitPolicy: '≤2 concurrent USDA calls, ≥250ms spacing, 2 retries'
    }
  },
  async (input) => {
    const options: FoodQueryOptions = {
      format: input.format,
      nutrients: input.nutrients
    };

    const food = await client.getFood(input.fdcId, options);
    const macros = extractMacroSummary(food);
    const macroHeadline = describeMacroSummary(macros);

    const summaryNotes: string[] = [];
    if (!macros) {
      summaryNotes.push('Macro summary not provided in USDA response.');
    }

    const summary = {
      fdcId: input.fdcId,
      description: describeFood(food),
      ...(macros ? { macros } : {}),
      ...(summaryNotes.length ? { notes: summaryNotes } : {})
    };

    return {
      content: [
        {
          type: 'text',
          text: [`Fetched food ${describeFood(food)}.`, macroHeadline].filter(Boolean).join(' ')
        }
      ],
      structuredContent: {
        summary,
        food,
        ...(macros ? { macros } : {})
      }
    };
  }
);

const macroNutrientKeys: NutrientKey[] = ['calories', 'protein', 'fat', 'carbs'];

server.registerTool(
  'get_macros',
  {
    title: 'Get Macros',
    description:
      'Return per 100 g calories, protein, total fat, and carbohydrates for a FoodData Central entry.',
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      idempotentHint: true
    },
    inputSchema: {
      fdcId: z.number().int().positive()
    },
    outputSchema: macroOnlyOutputShape,
    _meta: {
      version: '2025-07-01',
      nutrientKeys: macroNutrientKeys,
      nutrientIds: Array.from(
        new Set<number>(
          macroNutrientKeys.flatMap((key) => Array.from(NUTRIENT_DEFINITIONS[key].ids.values()))
        )
      )
    }
  },
  async (input) => {
    const { food, matches } = await fetchFoodForNutrients(input.fdcId, macroNutrientKeys);
    const nutrientValues = macroNutrientKeys.map((key) => buildNutrientValue(key, matches[key]));
    const missingLabels = nutrientValues
      .filter((nutrient) => nutrient.valuePer100g === undefined)
      .map((nutrient) => nutrient.label);
    const notes = missingLabels.length
      ? [`Missing values for: ${missingLabels.join(', ')}.`]
      : [];

    const summary = {
      fdcId: input.fdcId,
      description: describeFood(food),
      ...(notes.length ? { notes } : {})
    };

    const headline = describeNutrientSeries(nutrientValues);

    return {
      content: [
        {
          type: 'text',
          text: `Per 100 g macros for ${summary.description}: ${headline}.`
        }
      ],
      structuredContent: {
        summary,
        nutrients: nutrientValues
      }
    };
  }
);

const singleNutrientTools: Array<{
  name: string;
  key: NutrientKey;
  title: string;
  description: string;
}> = [
  {
    name: 'get_fats',
    key: 'fat',
    title: 'Get Total Fat',
    description: 'Return per 100 g total fat for a FoodData Central entry.'
  },
  {
    name: 'get_protein',
    key: 'protein',
    title: 'Get Protein',
    description: 'Return per 100 g protein for a FoodData Central entry.'
  },
  {
    name: 'get_carbs',
    key: 'carbs',
    title: 'Get Carbohydrates',
    description: 'Return per 100 g carbohydrates for a FoodData Central entry.'
  },
  {
    name: 'get_kcal',
    key: 'calories',
    title: 'Get Calories',
    description: 'Return per 100 g calories for a FoodData Central entry.'
  },
  {
    name: 'get_satfats',
    key: 'saturatedFat',
    title: 'Get Saturated Fat',
    description: 'Return per 100 g saturated fat for a FoodData Central entry.'
  },
  {
    name: 'get_fiber',
    key: 'fiber',
    title: 'Get Dietary Fiber',
    description: 'Return per 100 g dietary fiber for a FoodData Central entry.'
  }
];

for (const tool of singleNutrientTools) {
  registerSingleNutrientTool(tool);
}

server.registerTool(
  'get-foods',
  {
    title: 'Get Multiple Foods',
    description:
      'Batch lookup for multiple FDC IDs via the USDA bulk endpoint. Provide up to 50 IDs to reduce repeated network calls. Supports abridged/full detail and nutrient filters per the API.',
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      idempotentHint: true
    },
    inputSchema: {
      fdcIds: z.array(z.number().int().positive()).min(1).max(50),
      format: z.enum(['abridged', 'full']).optional(),
      nutrients: nutrientIdsSchema.optional(),
      previewOnly: z.boolean().optional(),
      includeRaw: z.boolean().optional(),
      sampleSize: z.number().int().min(1).max(MAX_PREVIEW_SAMPLE_SIZE).optional(),
      estimateOnly: z.boolean().optional()
    },
    outputSchema: bulkFoodsOutputShape,
    _meta: {
      version: '2025-07-01',
      supportsPreview: true,
      supportsDryRun: true,
      rateLimitPolicy: '≤2 concurrent USDA calls, ≥250ms spacing, 2 retries'
    }
  },
  async (input) => {
    const previewOnly = input.previewOnly ?? false;
    const includeRaw = input.includeRaw ?? !previewOnly;
    const estimateOnly = input.estimateOnly ?? false;
    const sampleSize = clampSampleSize(
      input.sampleSize,
      Math.min(DEFAULT_PREVIEW_SAMPLE_SIZE, input.fdcIds.length, MAX_PREVIEW_SAMPLE_SIZE)
    );

    if (estimateOnly) {
      const notes = [
        'Dry-run mode: no USDA request sent.',
        `Would request details for ${input.fdcIds.length} FDC IDs.`
      ];
      const summary = {
        requested: input.fdcIds.length,
        returned: 0,
        dryRun: true,
        notes
      };
      return {
        content: [
          {
            type: 'text',
            text: `Dry run: would fetch ${input.fdcIds.length} food records (${input.fdcIds.slice(0, 5).join(', ')}${input.fdcIds.length > 5 ? '…' : ''}).`
          }
        ],
        structuredContent: {
          summary,
          previews: []
        }
      };
    }

    const foods = await client.getFoods({
      fdcIds: input.fdcIds,
      format: input.format,
      nutrients: input.nutrients
    });

    const summaries = foods.map((food) => toFoodSummary(food));
    const previewSummaries = summaries.slice(0, sampleSize);

    const notes: string[] = [];
    if (previewOnly) {
      notes.push(`Preview mode enabled; returning ${previewSummaries.length} summaries.`);
    }
    if (!includeRaw) {
      notes.push('Full USDA payload omitted to conserve context. Set includeRaw=true to include it.');
    }

    const summary = {
      requested: input.fdcIds.length,
      returned: previewOnly ? previewSummaries.length : foods.length,
      ...(previewOnly ? { previewOnly: true } : {}),
      ...(notes.length ? { notes } : {})
    };

    const examples = previewSummaries.slice(0, 3).map((food) => food.description).join('; ');
    const lines = [
      `Retrieved ${previewOnly ? previewSummaries.length : foods.length} of ${input.fdcIds.length} requested foods.`,
      examples ? `Examples: ${examples}.` : undefined,
      previewOnly ? 'Preview mode active; set previewOnly=false for full payload.' : undefined
    ].filter((line): line is string => Boolean(line));

    return {
      content: [
        {
          type: 'text',
          text: lines.join(' ')
        }
      ],
      structuredContent: {
        summary,
        previews: previewSummaries,
        ...(includeRaw ? { foods } : {})
      }
    };
  }
);

server.registerTool(
  'list-foods',
  {
    title: 'List Foods',
    description:
      'Page-oriented listing endpoint for predictable iteration when you already know the data type or brand. Supports pagination, sorting, and brand filters, returning summaries for quick scanning.',
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    },
    inputSchema: listFoodsInputShape,
    outputSchema: listFoodsOutputShape,
    _meta: {
      version: '2025-07-01',
      defaultPageSize: DEFAULT_LIST_PAGE_SIZE,
      supportsCursor: true,
      supportsPreview: true,
      supportsDryRun: true,
      rateLimitPolicy: '≤2 concurrent USDA calls, ≥250ms spacing, 2 retries'
    }
  },
  async (input) => {
    const previewOnly = input.previewOnly ?? false;
    const includeRaw = input.includeRaw ?? !previewOnly;
    const estimateOnly = input.estimateOnly ?? false;
    const sampleSize = clampSampleSize(input.sampleSize);

    const filters = input.filters ?? {};
    const pagination = input.pagination ?? {};
    const sort = input.sort ?? {};

    let cursorPayload: CursorDetails | undefined;
    if (pagination.cursor) {
      if (pagination.page !== undefined || pagination.size !== undefined) {
        throw new Error('Provide either pagination.cursor or pagination.page/pagination.size, not both.');
      }
      cursorPayload = decodeCursor(pagination.cursor, 'list-foods');
    }

    const rawPageNumber = cursorPayload?.page ?? pagination.page ?? 1;
    const rawPageSize = cursorPayload?.size ?? pagination.size ?? DEFAULT_LIST_PAGE_SIZE;
    const pageNumber = Math.max(1, Math.trunc(rawPageNumber));
    const pageSize = Math.min(Math.max(Math.trunc(rawPageSize), 1), MAX_PAGE_SIZE);

    if (estimateOnly) {
      const notes = [
        'Dry-run mode: no USDA request sent.',
        `Would list page ${pageNumber} (size ${pageSize}).`
      ];
      const summary = {
        page: pageNumber,
        pageSize,
        returned: 0,
        dryRun: true,
        notes
      };
      return {
        content: [
          {
            type: 'text',
            text: `Dry run: list would request page ${pageNumber} with size ${pageSize}.`
          }
        ],
        structuredContent: {
          summary,
          previews: []
        }
      };
    }

    const params: ListFoodsRequest = {
      dataType: filters.dataTypes,
      brandOwner: filters.brandOwner,
      pageNumber,
      pageSize,
      sortBy: sort.by,
      sortOrder: sort.direction
    };

    const foods = await client.listFoods(params);
    const summaries = foods.map((food) => toFoodSummary(food));
    const previewSummaries = summaries.slice(0, sampleSize);

    const nextCursor =
      foods.length === pageSize ? encodeCursor('list-foods', pageNumber + 1, pageSize) : undefined;

    const notes: string[] = [];
    if (previewOnly) {
      notes.push(`Preview mode enabled; returning ${previewSummaries.length} summaries.`);
    }
    if (!includeRaw) {
      notes.push('Raw USDA payload omitted to conserve context. Set includeRaw=true to include it.');
    }

    const requestedFilters =
      filters.dataTypes || filters.brandOwner
        ? {
            ...(filters.dataTypes ? { dataTypes: filters.dataTypes } : {}),
            ...(filters.brandOwner ? { brandOwner: filters.brandOwner } : {})
          }
        : undefined;

    const summary = {
      page: pageNumber,
      pageSize,
      returned: previewOnly ? previewSummaries.length : foods.length,
      ...(requestedFilters ? { requestedFilters } : {}),
      ...(nextCursor ? { nextCursor } : {}),
      ...(previewOnly ? { previewOnly: true } : {}),
      ...(notes.length ? { notes } : {})
    };

    const headline = previewSummaries
      .slice(0, 3)
      .map((food) => food.description)
      .join('; ');
    const lines = [
      `Listed ${summary.returned} foods for page ${pageNumber} (size ${pageSize}).`,
      headline ? `Examples: ${headline}.` : foods.length ? undefined : 'No foods returned for this page.',
      previewOnly ? 'Preview mode active; set previewOnly=false for full payload.' : undefined
    ].filter((line): line is string => Boolean(line));

    return {
      content: [
        {
          type: 'text',
          text: lines.join(' ')
        }
      ],
      structuredContent: {
        summary,
        previews: previewSummaries,
        ...(includeRaw ? { foods } : {})
      }
    };
  }
);

server.registerResource(
  'usda-environment',
  'config://usda-fooddata/environment',
  {
    title: 'USDA FoodData Server Environment',
    description: 'Summarises configuration defaults, overrides, and operational guidance for this MCP server.',
    mimeType: 'text/markdown'
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        text: buildEnvironmentOverview()
      }
    ]
  })
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.resume();
  await waitForShutdown();
}

main().catch((error) => {
  console.error('USDA FoodData Central MCP server crashed.');
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});

async function waitForShutdown(): Promise<void> {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

  await new Promise<void>((resolve) => {
    let resolved = false;

    const originalOnClose = server.server.onclose;
    const keepAlive = setInterval(() => {
      // Prevent the process from exiting before the client connects.
    }, 1 << 30);

    const cleanup = (): void => {
      clearInterval(keepAlive);
      for (const signal of signals) {
        process.removeListener(signal, handleSignal);
      }
      server.server.onclose = originalOnClose;
    };

    const resolveOnce = (): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup();
      resolve();
    };

    const handleSignal = (): void => {
      if (resolved) {
        return;
      }

      server
        .close()
        .catch((closeError) => {
          console.error('Failed to close USDA FoodData Central MCP server gracefully.');
          if (closeError instanceof Error) {
            console.error(closeError.message);
          } else {
            console.error(String(closeError));
          }
        })
        .finally(resolveOnce);
    };

    server.server.onclose = () => {
      if (typeof originalOnClose === 'function') {
        originalOnClose();
      }
      resolveOnce();
    };

    for (const signal of signals) {
      process.on(signal, handleSignal);
    }
  });
}

function clampSampleSize(value?: number, fallback: number = DEFAULT_PREVIEW_SAMPLE_SIZE): number {
  const base = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const bounded = Math.min(Math.max(Math.trunc(base), 1), MAX_PREVIEW_SAMPLE_SIZE);
  return bounded;
}

function encodeCursor(tool: CursorTool, page: number, size: number): string {
  const payload = {
    tool,
    page: Math.max(1, Math.trunc(page)),
    size: Math.min(Math.max(Math.trunc(size), 1), MAX_PAGE_SIZE)
  };
  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json, 'utf8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function decodeCursor(cursor: string, expectedTool: CursorTool): CursorDetails {
  try {
    const normalized = normalizeBase64Url(cursor);
    const json = Buffer.from(normalized, 'base64').toString('utf8');
    const payload = JSON.parse(json) as Partial<CursorDetails & { tool?: string }>;
    if (payload.tool !== expectedTool) {
      throw new Error('Cursor tool mismatch.');
    }
    if (typeof payload.page !== 'number' || !Number.isFinite(payload.page) || payload.page < 1) {
      throw new Error('Cursor page missing or invalid.');
    }
    const fallbackSize = DEFAULT_CURSOR_SIZES[expectedTool] ?? DEFAULT_LIST_PAGE_SIZE;
    const rawSize =
      typeof payload.size === 'number' && Number.isFinite(payload.size) && payload.size >= 1
        ? payload.size
        : fallbackSize;
    return {
      page: Math.max(1, Math.trunc(payload.page)),
      size: Math.min(Math.max(Math.trunc(rawSize), 1), MAX_PAGE_SIZE)
    };
  } catch {
    throw new Error(`Invalid pagination cursor for ${expectedTool}.`);
  }
}

function normalizeBase64Url(value: string): string {
  const replaced = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = replaced.length % 4 === 0 ? 0 : 4 - (replaced.length % 4);
  return padLength ? replaced.padEnd(replaced.length + padLength, '=') : replaced;
}

function estimateResultSize(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload ?? {}), 'utf8');
  } catch {
    return 0;
  }
}

function describeFood(food: FoodItem): string {
  const description =
    typeof food.description === 'string'
      ? food.description
      : typeof food.lowercaseDescription === 'string'
        ? food.lowercaseDescription
        : 'Food item';
  const brand = typeof food.brandOwner === 'string' ? ` (${food.brandOwner})` : '';
  const fdcId =
    typeof food.fdcId === 'number'
      ? food.fdcId
      : typeof food.fdcId === 'string'
        ? food.fdcId
        : undefined;
  return `${description}${brand}${fdcId ? ` [FDC ${fdcId}]` : ''}`;
}

type MacroSummary = {
  calories?: number;
  protein?: number;
  fat?: number;
  carbs?: number;
};

type NutrientMatch = {
  value: number;
  nutrientId?: number;
};

type NutrientValue = {
  key: NutrientKey;
  label: string;
  unit: 'g' | 'kcal';
  valuePer100g?: number;
  sourceNutrientId?: number;
};

function extractMacroSummary(food: FoodItem): MacroSummary | undefined {
  const matches = collectNutrients(food, ['calories', 'protein', 'fat', 'carbs']);
  const summary: MacroSummary = {
    ...(matches.calories ? { calories: matches.calories.value } : {}),
    ...(matches.protein ? { protein: matches.protein.value } : {}),
    ...(matches.fat ? { fat: matches.fat.value } : {}),
    ...(matches.carbs ? { carbs: matches.carbs.value } : {})
  };

  return Object.values(summary).some((value) => value !== undefined) ? summary : undefined;
}

function extractNutrient(food: FoodItem, key: NutrientKey): NutrientMatch | undefined {
  const matches = collectNutrients(food, [key]);
  return matches[key];
}

function collectNutrients(
  food: FoodItem,
  keys: NutrientKey[]
): Partial<Record<NutrientKey, NutrientMatch>> {
  const nutrients = (food as Record<string, unknown>)?.foodNutrients;
  if (!Array.isArray(nutrients) || keys.length === 0) {
    return {};
  }

  const pending = new Set<NutrientKey>(keys);
  const results: Partial<Record<NutrientKey, NutrientMatch>> = {};

  for (const entry of nutrients) {
    if (pending.size === 0) {
      break;
    }

    const nutrientId = resolveNutrientId(entry);
    const nutrientName = resolveNutrientName(entry);
    const amount = resolveNutrientAmount(entry);

    if (amount === undefined) {
      continue;
    }

    for (const key of Array.from(pending)) {
      const definition = NUTRIENT_DEFINITIONS[key];
      const idMatches = nutrientId !== undefined && definition.ids.has(nutrientId);
      const nameMatches = nutrientName !== undefined && definition.names.has(nutrientName);
      if (!idMatches && !nameMatches) {
        continue;
      }

      results[key] = {
        value: amount,
        ...(nutrientId !== undefined ? { nutrientId } : {})
      };
      pending.delete(key);
    }
  }

  return results;
}

function buildNutrientValue(key: NutrientKey, match?: NutrientMatch): NutrientValue {
  const definition = NUTRIENT_DEFINITIONS[key];
  return {
    key,
    label: definition.label,
    unit: definition.unit,
    ...(match ? { valuePer100g: match.value } : {}),
    ...(match?.nutrientId !== undefined ? { sourceNutrientId: match.nutrientId } : {})
  };
}

async function fetchFoodForNutrients(
  fdcId: number,
  keys: NutrientKey[]
): Promise<{ food: FoodItem; matches: Partial<Record<NutrientKey, NutrientMatch>> }> {
  const nutrientIds = new Set<number>();
  for (const key of keys) {
    for (const id of NUTRIENT_DEFINITIONS[key].ids) {
      nutrientIds.add(id);
    }
  }

  const options: FoodQueryOptions = {
    format: 'abridged',
    ...(nutrientIds.size ? { nutrients: Array.from(nutrientIds) } : {})
  };

  const food = await client.getFood(fdcId, options);
  const matches = collectNutrients(food, keys);
  return { food, matches };
}

function describeNutrientSeries(values: NutrientValue[]): string {
  return values
    .map((nutrient) => {
      const amount = formatNutrientAmount(nutrient);
      return amount ? `${nutrient.label} ${amount}` : `${nutrient.label} unavailable`;
    })
    .join('; ');
}

function describeSingleNutrientSentence(description: string, nutrient: NutrientValue): string {
  const amount = formatNutrientAmount(nutrient);
  if (!amount) {
    return `${nutrient.label} unavailable for ${description}.`;
  }
  return `${nutrient.label} for ${description}: ${amount} per 100 g.`;
}

function formatNutrientAmount(nutrient: NutrientValue): string | undefined {
  if (nutrient.valuePer100g === undefined) {
    return undefined;
  }
  if (nutrient.unit === 'kcal') {
    return `${formatMacroValue(nutrient.valuePer100g, false)} kcal`;
  }
  return `${formatMacroValue(nutrient.valuePer100g)} g`;
}

function registerSingleNutrientTool(config: {
  name: string;
  key: NutrientKey;
  title: string;
  description: string;
}): void {
  const definition = NUTRIENT_DEFINITIONS[config.key];
  server.registerTool(
    config.name,
    {
      title: config.title,
      description: `${config.description} Returns a single value per 100 g to minimize context usage.`,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        idempotentHint: true
      },
      inputSchema: {
        fdcId: z.number().int().positive()
      },
      outputSchema: singleNutrientOutputShape,
      _meta: {
        version: '2025-07-01',
        nutrientKey: config.key,
        nutrientLabel: definition.label,
        nutrientIds: Array.from(definition.ids)
      }
    },
    async (input) => {
      const { food, matches } = await fetchFoodForNutrients(input.fdcId, [config.key]);
      const nutrientMatch = matches[config.key];
      const nutrientValue = buildNutrientValue(config.key, nutrientMatch);
      const notes =
        nutrientValue.valuePer100g === undefined
          ? [`${definition.label} not available for this entry.`]
          : [];
      const summary = {
        fdcId: input.fdcId,
        description: describeFood(food),
        ...(notes.length ? { notes } : {})
      };

      return {
        content: [
          {
            type: 'text',
            text: describeSingleNutrientSentence(summary.description, nutrientValue)
          }
        ],
        structuredContent: {
          summary,
          nutrient: nutrientValue
        }
      };
    }
  );
}

function resolveNutrientId(entry: unknown): number | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }

  const base = entry as Record<string, unknown>;

  const nutrientIdCandidate = base.nutrientId ?? base.nutrientID ?? base.nutrient_id;
  const directNumberCandidate = base.nutrientNumber ?? base.number;
  const nutrient = getRecord(base.nutrient);

  return (
    toFiniteNumber(nutrientIdCandidate) ??
    toFiniteNumber(nutrient?.id ?? nutrient?.nutrientId) ??
    toFiniteNumber(nutrient?.number) ??
    toFiniteNumber(directNumberCandidate)
  );
}

function resolveNutrientName(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }

  const base = entry as Record<string, unknown>;
  const nutrient = getRecord(base.nutrient);

  const candidates = [
    typeof base.nutrientName === 'string' ? base.nutrientName : undefined,
    typeof base.nutrientDescription === 'string' ? base.nutrientDescription : undefined,
    typeof nutrient?.name === 'string' ? nutrient.name : undefined,
    typeof nutrient?.description === 'string' ? nutrient.description : undefined,
    typeof nutrient?.displayName === 'string' ? nutrient.displayName : undefined
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim().toLowerCase();
    }
  }

  return undefined;
}

function resolveNutrientAmount(entry: unknown): number | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }

  const base = entry as Record<string, unknown>;
  const nutrient = getRecord(base.nutrient);

  return (
    toFiniteNumber(base.amount ?? base.value ?? base.dataPoints) ??
    toFiniteNumber(nutrient?.amount ?? nutrient?.value)
  );
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function describeMacroSummary(macros?: MacroSummary): string {
  if (!macros) {
    return '';
  }

  const parts: string[] = [];
  if (macros.calories !== undefined) {
    parts.push(`calories ${formatMacroValue(macros.calories, false)} kcal`);
  }
  if (macros.protein !== undefined) {
    parts.push(`protein ${formatMacroValue(macros.protein)} g`);
  }
  if (macros.fat !== undefined) {
    parts.push(`fat ${formatMacroValue(macros.fat)} g`);
  }
  if (macros.carbs !== undefined) {
    parts.push(`carbs ${formatMacroValue(macros.carbs)} g`);
  }

  return parts.length ? `Macros per 100g: ${parts.join(', ')}.` : '';
}

function formatMacroValue(value: number, allowDecimals: boolean = true): string {
  if (!allowDecimals) {
    return Math.round(value).toString();
  }

  const rounded = Math.round(value * 100) / 100;
  return rounded.toString();
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type FoodSummary = {
  fdcId?: number;
  description: string;
  dataType?: string;
  brandOwner?: string;
  publishedDate?: string;
  macros?: MacroSummary;
};

type SearchPreview = {
  fdcId: number;
  description: string;
  dataType?: string;
  brandOwner?: string;
};

function toFoodSummary(food: FoodItem): FoodSummary {
  const macros = extractMacroSummary(food);
  const fdcId = extractFdcId(food);
  const record = getRecord(food);
  const dataType = typeof record?.dataType === 'string' ? record.dataType : undefined;
  const brandOwner = typeof record?.brandOwner === 'string' ? record.brandOwner : undefined;
  const publishedDate =
    typeof record?.publishedDate === 'string' ? record.publishedDate : undefined;

  return {
    description: describeFood(food),
    ...(fdcId !== undefined ? { fdcId } : {}),
    ...(dataType ? { dataType } : {}),
    ...(brandOwner ? { brandOwner } : {}),
    ...(publishedDate ? { publishedDate } : {}),
    ...(macros ? { macros } : {})
  };
}

function toSearchPreview(food: FoodItem): SearchPreview {
  const record = getRecord(food);
  const rawFdcId = record?.fdcId ?? record?.fdc_id;
  const parsedFdcId = toFiniteNumber(rawFdcId);
  if (parsedFdcId === undefined) {
    throw new Error('Search result is missing an FDC ID.');
  }

  const description =
    typeof record?.description === 'string'
      ? record.description
      : typeof record?.lowercaseDescription === 'string'
        ? record.lowercaseDescription
        : 'Food item';

  const dataType = typeof record?.dataType === 'string' ? record.dataType : undefined;
  const brandOwner = typeof record?.brandOwner === 'string' ? record.brandOwner : undefined;

  return {
    fdcId: parsedFdcId,
    description,
    ...(dataType ? { dataType } : {}),
    ...(brandOwner ? { brandOwner } : {})
  };
}

function extractFdcId(food: FoodItem): number | undefined {
  const record = getRecord(food);
  if (!record) {
    return undefined;
  }

  return toFiniteNumber(record.fdcId ?? record.fdc_id);
}

function buildEnvironmentOverview(): string {
  const apiKeyStatus = process.env.USDA_API_KEY
    ? 'USDA_API_KEY detected in environment.'
    : 'USDA_API_KEY missing — the server will fail to start until it is provided.';
  const baseUrl = process.env.USDA_API_BASE_URL ?? USDA_API_BASE_URL;

  return [
    '# USDA FoodData Central MCP Environment',
    '',
    `- Base URL: ${baseUrl}`,
    `- API key mode: ${apiKeyStatus}`,
    '- Request policy: up to 2 concurrent USDA calls with ≥250ms spacing and up to 2 exponential backoff retries on HTTP 429/5xx or timeouts.',
    '- Timeout: Each request aborts after 30s to keep the server responsive.',
    '',
    describeEnvironmentOverride(),
    '',
    'Set USDA_API_BASE_URL to point at a proxy or alternate API host when needed.'
  ].join('\n');
}
