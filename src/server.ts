import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z, type ZodRawShape } from 'zod';

import {
  FoodDataCentralClient,
  FoodDataCentralError,
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
  'Respect USDA rate limits: at most one live request at a time with ≥400ms spacing (≈3 requests/second ceiling), so batch lookups thoughtfully.',
  'Expect structuredContent payloads for reliable downstream parsing.'
].join('\n');

const server = new McpServer(
  {
    name: 'usda-fooddata-central',
    version: '1.0.0'
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
  requestedFdcIds: z.array(z.number().int().positive()).min(1).optional(),
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

type FdcIdAlias = {
  replacementId: number;
  dataset?: string;
  rationale?: string;
};

type AliasResolution = {
  requestedId: number;
  alias: FdcIdAlias;
};

const FDC_ID_ALIASES: ReadonlyMap<number, FdcIdAlias> = new Map([
  [
    4053,
    {
      replacementId: 748608,
      dataset: 'Foundation',
      rationale: 'USDA retired the SR Legacy olive oil record; the Foundation entry retains the same nutrient profile.'
    }
  ]
]);

const NUTRIENT_KEYS = [
  'calories',
  'protein',
  'fat',
  'carbs',
  'saturatedFat',
  'fiber',
  'calcium',
  'iron',
  'potassium',
  'sodium',
  'magnesium',
  'zinc',
  'vitaminA',
  'vitaminC',
  'vitaminD',
  'vitaminE',
  'vitaminK',
  'folate',
  'vitaminB6',
  'vitaminB12'
] as const;

type NutrientKey = (typeof NUTRIENT_KEYS)[number];

type NutrientUnit = 'g' | 'kcal' | 'mg' | 'mcg';

type NutrientDefinition = {
  key: NutrientKey;
  label: string;
  unit: NutrientUnit;
  ids: ReadonlySet<number>;
  names: ReadonlySet<string>;
};

const NUTRIENT_DEFINITIONS: Record<NutrientKey, NutrientDefinition> = {
  calories: {
    key: 'calories',
    label: 'Calories',
    unit: 'kcal',
    ids: new Set([1008, 208]),
    names: new Set(
      ['energy', 'energy (atwater general factors)', 'energy (kcal)', 'calories'].map((value) =>
        value.toLowerCase()
      )
    )
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
    ids: new Set([1004, 204, 1085]),
    names: new Set(
      ['total lipid (fat)', 'total fat', 'total fat (nlea)', 'total lipid (nlea)'].map((value) =>
        value.toLowerCase()
      )
    )
  },
  carbs: {
    key: 'carbs',
    label: 'Carbohydrates',
    unit: 'g',
    ids: new Set([1005, 205, 2039]),
    names: new Set(
      ['carbohydrate, by difference', 'carbohydrates', 'total carbohydrate (nlea)'].map((value) =>
        value.toLowerCase()
      )
    )
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
  },
  calcium: {
    key: 'calcium',
    label: 'Calcium',
    unit: 'mg',
    ids: new Set([1087, 301]),
    names: new Set(['calcium', 'calcium, ca'].map((value) => value.toLowerCase()))
  },
  iron: {
    key: 'iron',
    label: 'Iron',
    unit: 'mg',
    ids: new Set([1089, 303]),
    names: new Set(['iron', 'iron, fe'].map((value) => value.toLowerCase()))
  },
  potassium: {
    key: 'potassium',
    label: 'Potassium',
    unit: 'mg',
    ids: new Set([1092, 306]),
    names: new Set(['potassium', 'potassium, k'].map((value) => value.toLowerCase()))
  },
  sodium: {
    key: 'sodium',
    label: 'Sodium',
    unit: 'mg',
    ids: new Set([1093, 307]),
    names: new Set(['sodium', 'sodium, na'].map((value) => value.toLowerCase()))
  },
  magnesium: {
    key: 'magnesium',
    label: 'Magnesium',
    unit: 'mg',
    ids: new Set([1090, 304]),
    names: new Set(['magnesium', 'magnesium, mg'].map((value) => value.toLowerCase()))
  },
  zinc: {
    key: 'zinc',
    label: 'Zinc',
    unit: 'mg',
    ids: new Set([1095, 309]),
    names: new Set(['zinc', 'zinc, zn'].map((value) => value.toLowerCase()))
  },
  vitaminA: {
    key: 'vitaminA',
    label: 'Vitamin A (RAE)',
    unit: 'mcg',
    ids: new Set([1104, 318]),
    names: new Set(['vitamin a', 'vitamin a, rae', 'vitamin a, iu'].map((value) => value.toLowerCase()))
  },
  vitaminC: {
    key: 'vitaminC',
    label: 'Vitamin C',
    unit: 'mg',
    ids: new Set([1162, 401]),
    names: new Set(['vitamin c', 'vitamin c, total ascorbic acid'].map((value) => value.toLowerCase()))
  },
  vitaminD: {
    key: 'vitaminD',
    label: 'Vitamin D',
    unit: 'mcg',
    ids: new Set([1114, 324, 328]),
    names: new Set(['vitamin d', 'vitamin d (d2 + d3)'].map((value) => value.toLowerCase()))
  },
  vitaminE: {
    key: 'vitaminE',
    label: 'Vitamin E',
    unit: 'mg',
    ids: new Set([1109, 323]),
    names: new Set(['vitamin e', 'vitamin e (alpha-tocopherol)'].map((value) => value.toLowerCase()))
  },
  vitaminK: {
    key: 'vitaminK',
    label: 'Vitamin K',
    unit: 'mcg',
    ids: new Set([1185, 430]),
    names: new Set(['vitamin k', 'vitamin k (phylloquinone)'].map((value) => value.toLowerCase()))
  },
  folate: {
    key: 'folate',
    label: 'Folate',
    unit: 'mcg',
    ids: new Set([1186, 417]),
    names: new Set(['folate', 'folate, total'].map((value) => value.toLowerCase()))
  },
  vitaminB6: {
    key: 'vitaminB6',
    label: 'Vitamin B6',
    unit: 'mg',
    ids: new Set([1175, 415]),
    names: new Set(['vitamin b6', 'vitamin b-6'].map((value) => value.toLowerCase()))
  },
  vitaminB12: {
    key: 'vitaminB12',
    label: 'Vitamin B12',
    unit: 'mcg',
    ids: new Set([1178, 418]),
    names: new Set(['vitamin b12', 'vitamin b-12'].map((value) => value.toLowerCase()))
  }
};

const LABEL_CANDIDATE_OVERRIDES: Partial<Record<NutrientKey, ReadonlyArray<string>>> = {
  calories: ['calories', 'energy', 'energy (kcal)'],
  protein: ['protein', 'protein (nlea)'],
  fat: ['fat', 'totalFat', 'total fat', 'total fat (nlea)', 'total lipid (fat)', 'total lipid (nlea)'],
  carbs: [
    'carbohydrates',
    'carbs',
    'totalCarbohydrate',
    'total carbohydrate',
    'total carbohydrate (nlea)'
  ],
  saturatedFat: ['saturatedFat', 'saturated fat'],
  fiber: ['fiber', 'dietaryFiber', 'dietary fiber'],
  calcium: ['calcium'],
  iron: ['iron'],
  potassium: ['potassium'],
  sodium: ['sodium'],
  magnesium: ['magnesium'],
  zinc: ['zinc'],
  vitaminA: ['vitaminA', 'vitamin a', 'vitaminA (mcg)'],
  vitaminC: ['vitaminC', 'vitamin c'],
  vitaminD: ['vitaminD', 'vitamin d'],
  vitaminE: ['vitaminE', 'vitamin e'],
  vitaminK: ['vitaminK', 'vitamin k'],
  folate: ['folate'],
  vitaminB6: ['vitaminB6', 'vitamin b6', 'vitamin b-6'],
  vitaminB12: ['vitaminB12', 'vitamin b12', 'vitamin b-12']
};

const LABEL_NUTRIENT_CANDIDATES: Record<NutrientKey, ReadonlyArray<string>> = NUTRIENT_KEYS.reduce(
  (acc, key) => {
    const definitionNames = Array.from(NUTRIENT_DEFINITIONS[key].names);
    const overrides = LABEL_CANDIDATE_OVERRIDES[key] ?? [];
    const merged = new Set<string>([...overrides, ...definitionNames]);
    acc[key] = Array.from(merged);
    return acc;
  },
  {} as Record<NutrientKey, ReadonlyArray<string>>
);

const nutrientValueSchema = z
  .object({
    key: z.enum(NUTRIENT_KEYS),
    label: z.string(),
    unit: z.enum(['g', 'kcal', 'mg', 'mcg']),
    valuePer100g: z.number().nonnegative().optional(),
    valuePerPortion: z.number().nonnegative().optional(),
    sourceNutrientId: z.number().optional()
  })
  .strict();

const singleNutrientOutputShape = {
  summary: z
    .object({
      fdcId: z.number(),
      description: z.string(),
      dataType: z.string().optional(),
      notes: z.array(z.string()).optional()
    })
    .strict(),
  nutrient: nutrientValueSchema
} satisfies ZodRawShape;

const nutrientListOutputShape = {
  summary: z
    .object({
      fdcId: z.number(),
      description: z.string(),
      notes: z.array(z.string()).optional()
    })
    .strict(),
  nutrients: z.array(nutrientValueSchema)
} satisfies ZodRawShape;

const categoryEntrySchema = z
  .object({
    kind: z.enum(['foodCategory', 'brandedFoodCategory', 'wweiaFoodCategory']),
    id: z.number().int().optional(),
    code: z.string().optional(),
    description: z.string()
  })
  .strict();

const categoryListOutputShape = {
  summary: z
    .object({
      fdcId: z.number(),
      description: z.string(),
      dataType: z.string().optional(),
      notes: z.array(z.string()).optional()
    })
    .strict(),
  categories: z.array(categoryEntrySchema)
} satisfies ZodRawShape;

const portionEntrySchema = z
  .object({
    id: z.number().int().optional(),
    amount: z.number().optional(),
    portionDescription: z.string().optional(),
    gramWeight: z.number().optional(),
    measureUnit: z
      .object({
        id: z.number().int().optional(),
        abbreviation: z.string().optional(),
        name: z.string().optional()
      })
      .strict()
      .optional()
  })
  .strict();

const portionListOutputShape = {
  summary: z
    .object({
      fdcId: z.number(),
      description: z.string(),
      dataType: z.string().optional(),
      notes: z.array(z.string()).optional()
    })
    .strict(),
  portions: z.array(portionEntrySchema)
} satisfies ZodRawShape;

const macroPortionSummarySchema = z
  .object({
    fdcId: z.number(),
    description: z.string(),
    dataType: z.string().optional(),
    portionId: z.number().int().optional(),
    portionIndex: z.number().int().min(0).optional(),
    amount: z.number().optional(),
    portionDescription: z.string().optional(),
    gramWeight: z.number().optional(),
    notes: z.array(z.string()).optional()
  })
  .strict();

const macroPortionOutputShape = {
  summary: macroPortionSummarySchema,
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
      rateLimitPolicy: '≤1 concurrent USDA call, ≥400ms spacing, 2 retries'
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
      rateLimitPolicy: '≤1 concurrent USDA call, ≥400ms spacing, 2 retries'
    }
  },
  async (input) => {
    const options: FoodQueryOptions = {
      format: input.format,
      nutrients: input.nutrients
    };

    const { food, aliasInfo } = await fetchFoodWithAlias(input.fdcId, options);
    const macros = extractMacroSummary(food);
    const macroHeadline = describeMacroSummary(macros);

    const summaryNotes: string[] = [];
    if (aliasInfo) {
      summaryNotes.push(formatAliasNote(aliasInfo, food));
    }
    if (!macros) {
      summaryNotes.push('Macro summary not provided in USDA response.');
    }

    const summary = {
      fdcId: input.fdcId,
      description: describeFood(food),
      dataType:
        typeof (getRecord(food)?.dataType) === 'string'
          ? (getRecord(food)?.dataType as string)
          : undefined,
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

server.registerTool(
  'get_categories',
  {
    title: 'Get Food Categories',
    description:
      'Return category tags for a FoodData Central entry, including FoodCategory, brandedFoodCategory, and WweiaFoodCategory when available.',
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      idempotentHint: true
    },
    inputSchema: {
      fdcId: z.number().int().positive()
    },
    outputSchema: categoryListOutputShape,
    _meta: {
      version: '2025-11-15'
    }
  },
  async (input) => {
    const { food, aliasInfo } = await fetchFoodWithAlias(input.fdcId, { format: 'full' });
    const record = getRecord(food) ?? {};
    const dataType = typeof record.dataType === 'string' ? record.dataType : undefined;

    const categories: Array<z.infer<typeof categoryEntrySchema>> = [];

    const foodCategory = getRecord(record.foodCategory);
    if (foodCategory) {
      const id = toFiniteNumber(foodCategory.id);
      const code =
        typeof foodCategory.code === 'string' && foodCategory.code.trim() !== ''
          ? foodCategory.code
          : undefined;
      const description =
        typeof foodCategory.description === 'string' && foodCategory.description.trim() !== ''
          ? foodCategory.description
          : undefined;
      if (description) {
        categories.push({
          kind: 'foodCategory',
          ...(id !== undefined ? { id } : {}),
          ...(code ? { code } : {}),
          description
        });
      }
    }

    if (typeof record.brandedFoodCategory === 'string' && record.brandedFoodCategory.trim() !== '') {
      categories.push({
        kind: 'brandedFoodCategory',
        description: record.brandedFoodCategory
      });
    }

    const wweia = getRecord(record.wweiaFoodCategory);
    if (wweia) {
      const code = toFiniteNumber(wweia.wweiaFoodCategoryCode);
      const description =
        typeof wweia.wweiaFoodCategoryDescription === 'string' &&
        wweia.wweiaFoodCategoryDescription.trim() !== ''
          ? wweia.wweiaFoodCategoryDescription
          : undefined;
      if (description) {
        categories.push({
          kind: 'wweiaFoodCategory',
          ...(code !== undefined ? { id: code } : {}),
          description
        });
      }
    }

    const notes: string[] = [];
    if (aliasInfo) {
      notes.push(formatAliasNote(aliasInfo, food));
    }
    if (!categories.length) {
      notes.push('No category fields found on this USDA record.');
    }

    const summary = {
      fdcId: input.fdcId,
      description: describeFood(food),
      ...(dataType ? { dataType } : {}),
      ...(notes.length ? { notes } : {})
    };

    const headlineParts: string[] = [];
    for (const category of categories) {
      const label = category.kind === 'wweiaFoodCategory' ? 'WWEIA' : category.kind;
      headlineParts.push(`${label}: ${category.description}`);
    }
    const headline =
      headlineParts.length > 0
        ? `Categories for ${summary.description}: ${headlineParts.join('; ')}.`
        : `No categories found for ${summary.description}.`;

    return {
      content: [
        {
          type: 'text',
          text: headline
        }
      ],
      structuredContent: {
        summary,
        categories
      }
    };
  }
);

const macroNutrientKeys: NutrientKey[] = ['calories', 'protein', 'fat', 'carbs'];
const microNutrientKeys: NutrientKey[] = [
  'calcium',
  'iron',
  'potassium',
  'sodium',
  'magnesium',
  'zinc',
  'vitaminA',
  'vitaminC',
  'vitaminD',
  'vitaminE',
  'vitaminK',
  'folate',
  'vitaminB6',
  'vitaminB12'
];
const macroMicronutrientKeys: NutrientKey[] = [...macroNutrientKeys, ...microNutrientKeys];

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
    outputSchema: nutrientListOutputShape,
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
    const { food, matches, aliasInfo } = await fetchFoodForNutrients(input.fdcId, macroNutrientKeys);
    const recordMeta = getRecord(food);
    const dataType =
      typeof recordMeta?.dataType === 'string' ? recordMeta.dataType.trim().toLowerCase() : undefined;
    const description = describeFood(food);
    const nutrientValues = macroNutrientKeys.map((key) => buildNutrientValue(key, matches[key]));
    const missingLabels = nutrientValues
      .filter((nutrient) => nutrient.valuePer100g === undefined)
      .map((nutrient) => nutrient.label);
    if (dataType === 'foundation' && missingLabels.length) {
      const aliasSuffix = aliasInfo ? ` ${formatAliasNote(aliasInfo, food)}` : '';
      const missingText = missingLabels.join(', ');
      throw new Error(
        `Foundation entry ${description} omits ${missingText}. Choose an FDC record that lists macros or derive the values manually.${aliasSuffix}`
      );
    }
    const notes: string[] = [];
    if (aliasInfo) {
      notes.push(formatAliasNote(aliasInfo, food));
    }
    if (missingLabels.length) {
      notes.push(`Missing values for: ${missingLabels.join(', ')}.`);
    }

    const summary = {
      fdcId: input.fdcId,
      description,
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

server.registerTool(
  'get_micros',
  {
    title: 'Get Micronutrients',
    description: 'Return per 100 g vitamins and minerals for a FoodData Central entry (Calcium through B vitamins).',
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      idempotentHint: true
    },
    inputSchema: {
      fdcId: z.number().int().positive()
    },
    outputSchema: nutrientListOutputShape,
    _meta: {
      version: '2025-11-07',
      nutrientKeys: microNutrientKeys,
      nutrientIds: Array.from(
        new Set<number>(
          microNutrientKeys.flatMap((key) => Array.from(NUTRIENT_DEFINITIONS[key].ids.values()))
        )
      )
    }
  },
  async (input) => {
    const { food, matches, aliasInfo } = await fetchFoodForNutrients(input.fdcId, microNutrientKeys);
    const description = describeFood(food);
    const nutrientValues = microNutrientKeys.map((key) => buildNutrientValue(key, matches[key]));
    const missingLabels = nutrientValues
      .filter((nutrient) => nutrient.valuePer100g === undefined)
      .map((nutrient) => nutrient.label);
    const notes: string[] = [];
    if (aliasInfo) {
      notes.push(formatAliasNote(aliasInfo, food));
    }
    if (missingLabels.length) {
      notes.push(`Missing values for: ${missingLabels.join(', ')}.`);
    }

    const summary = {
      fdcId: input.fdcId,
      description,
      ...(notes.length ? { notes } : {})
    };

    const headline = describeNutrientSeries(nutrientValues);

    return {
      content: [
        {
          type: 'text',
          text: headline
            ? `Micros per 100 g for ${summary.description}: ${headline}.`
            : `Micros unavailable for ${summary.description}.`
        }
      ],
      structuredContent: {
        summary,
        nutrients: nutrientValues
      }
    };
  }
);

server.registerTool(
  'get_macro_micros',
  {
    title: 'Get Macros + Micros',
    description: 'Return per 100 g macro plus vitamin/mineral panels for a FoodData Central entry.',
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      idempotentHint: true
    },
    inputSchema: {
      fdcId: z.number().int().positive()
    },
    outputSchema: nutrientListOutputShape,
    _meta: {
      version: '2025-11-07',
      nutrientKeys: macroMicronutrientKeys,
      nutrientIds: Array.from(
        new Set<number>(
          macroMicronutrientKeys.flatMap((key) => Array.from(NUTRIENT_DEFINITIONS[key].ids.values()))
        )
      )
    }
  },
  async (input) => {
    const { food, matches, aliasInfo } = await fetchFoodForNutrients(input.fdcId, macroMicronutrientKeys);
    const recordMeta = getRecord(food);
    const dataType =
      typeof recordMeta?.dataType === 'string' ? recordMeta.dataType.trim().toLowerCase() : undefined;
    const description = describeFood(food);
    const nutrientValues = macroMicronutrientKeys.map((key) => buildNutrientValue(key, matches[key]));
    const missingMacros = macroNutrientKeys
      .map((key) => buildNutrientValue(key, matches[key]))
      .filter((nutrient) => nutrient.valuePer100g === undefined)
      .map((nutrient) => nutrient.label);
    if (dataType === 'foundation' && missingMacros.length) {
      const aliasSuffix = aliasInfo ? ` ${formatAliasNote(aliasInfo, food)}` : '';
      const missingText = missingMacros.join(', ');
      throw new Error(
        `Foundation entry ${description} omits ${missingText}. Choose an FDC record that lists macros or derive the values manually.${aliasSuffix}`
      );
    }
    const notes: string[] = [];
    if (aliasInfo) {
      notes.push(formatAliasNote(aliasInfo, food));
    }
    const missingAll = nutrientValues
      .filter((nutrient) => nutrient.valuePer100g === undefined)
      .map((nutrient) => nutrient.label);
    if (missingAll.length) {
      notes.push(`Missing values for: ${missingAll.join(', ')}.`);
    }

    const summary = {
      fdcId: input.fdcId,
      description,
      ...(notes.length ? { notes } : {})
    };

    const headline = describeNutrientSeries(nutrientValues);

    return {
      content: [
        {
          type: 'text',
          text: headline
            ? `Per 100 g macros + micros for ${summary.description}: ${headline}.`
            : `Macros and micros unavailable for ${summary.description}.`
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
  'list_portions',
  {
    title: 'List Portions',
    description:
      'Return labeled portion sizes for a FoodData Central entry, including gram weights when available.',
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      idempotentHint: true
    },
    inputSchema: {
      fdcId: z.number().int().positive()
    },
    outputSchema: portionListOutputShape,
    _meta: {
      version: '2025-11-15'
    }
  },
  async (input) => {
    const { food, aliasInfo } = await fetchFoodWithAlias(input.fdcId, { format: 'full' });
    const record = getRecord(food) ?? {};
    const dataType = typeof record.dataType === 'string' ? record.dataType : undefined;

    const rawPortions = Array.isArray(record.foodPortions) ? record.foodPortions : [];
    const portions: Array<z.infer<typeof portionEntrySchema>> = [];

    for (const entry of rawPortions) {
      const portion = getRecord(entry);
      if (!portion) continue;

      const id = toFiniteNumber(portion.id);
      const amount = toFiniteNumber(portion.amount);
      const gramWeight = toFiniteNumber(portion.gramWeight);
      const portionDescription =
        typeof portion.portionDescription === 'string' && portion.portionDescription.trim() !== ''
          ? portion.portionDescription
          : undefined;

      const measureUnitRecord = getRecord(portion.measureUnit);
      const measureUnit =
        measureUnitRecord &&
        (typeof measureUnitRecord.abbreviation === 'string' ||
          typeof measureUnitRecord.name === 'string' ||
          measureUnitRecord.id !== undefined)
          ? {
              ...(toFiniteNumber(measureUnitRecord.id) !== undefined
                ? { id: toFiniteNumber(measureUnitRecord.id) }
                : {}),
              ...(typeof measureUnitRecord.abbreviation === 'string'
                ? { abbreviation: measureUnitRecord.abbreviation }
                : {}),
              ...(typeof measureUnitRecord.name === 'string'
                ? { name: measureUnitRecord.name }
                : {})
            }
          : undefined;

      if (portionDescription || gramWeight !== undefined || amount !== undefined || measureUnit) {
        portions.push({
          ...(id !== undefined ? { id } : {}),
          ...(amount !== undefined ? { amount } : {}),
          ...(portionDescription ? { portionDescription } : {}),
          ...(gramWeight !== undefined ? { gramWeight } : {}),
          ...(measureUnit ? { measureUnit } : {})
        });
      }
    }

    const notes: string[] = [];
    if (aliasInfo) {
      notes.push(formatAliasNote(aliasInfo, food));
    }
    if (!portions.length) {
      notes.push('No foodPortions data found on this USDA record.');
    }

    const summary = {
      fdcId: input.fdcId,
      description: describeFood(food),
      ...(dataType ? { dataType } : {}),
      ...(notes.length ? { notes } : {})
    };

    const headline =
      portions.length > 0
        ? `Found ${portions.length} portion${portions.length === 1 ? '' : 's'} for ${summary.description}.`
        : `No labeled portions found for ${summary.description}.`;

    return {
      content: [
        {
          type: 'text',
          text: headline
        }
      ],
      structuredContent: {
        summary,
        portions
      }
    };
  }
);

server.registerTool(
  'macros_for_portion',
  {
    title: 'Macros for Portion',
    description:
      'Return calories, protein, fat, and carbohydrates for a specific USDA-defined portion of a FoodData Central entry.',
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      idempotentHint: true
    },
    inputSchema: {
      fdcId: z.number().int().positive(),
      portionId: z.number().int().optional(),
      portionIndex: z.number().int().min(0).optional()
    },
    outputSchema: macroPortionOutputShape,
    _meta: {
      version: '2025-11-15',
      nutrientKeys: macroNutrientKeys
    }
  },
  async (input) => {
    const { portionId, portionIndex } = input;
    const hasPortionId = typeof portionId === 'number';
    const hasPortionIndex = typeof portionIndex === 'number';
    if ((hasPortionId && hasPortionIndex) || (!hasPortionId && !hasPortionIndex)) {
      throw new Error('Provide exactly one of portionId or portionIndex. Call list_portions first to inspect available portions.');
    }

    const nutrientResult = await fetchFoodForNutrients(input.fdcId, macroNutrientKeys);
    const { matches, aliasInfo: aliasFromNutrients } = nutrientResult;

    const fullResult = await fetchFoodWithAlias(input.fdcId, { format: 'full' });
    const food = fullResult.food;
    const aliasInfo = fullResult.aliasInfo ?? aliasFromNutrients;

    const record = getRecord(food) ?? {};
    const dataType = typeof record.dataType === 'string' ? record.dataType : undefined;

    const rawPortions = Array.isArray(record.foodPortions) ? record.foodPortions : [];
    if (!rawPortions.length) {
      const description = describeFood(food);
      throw new Error(
        `USDA record for ${description} has no foodPortions data. Use get_macros for per-100 g values or choose a different FDC ID.`
      );
    }

    let selectedPortionRecord: Record<string, unknown> | undefined;
    let resolvedIndex: number | undefined;

    if (hasPortionId) {
      const targetId = portionId as number;
      for (let index = 0; index < rawPortions.length; index += 1) {
        const portion = getRecord(rawPortions[index]);
        if (!portion) continue;
        const id = toFiniteNumber(portion.id);
        if (id !== undefined && id === targetId) {
          selectedPortionRecord = portion;
          resolvedIndex = index;
          break;
        }
      }
      if (!selectedPortionRecord) {
        const description = describeFood(food);
        throw new Error(
          `Portion with id ${targetId} not found for ${description}. Call list_portions to see valid portion ids.`
        );
      }
    } else if (hasPortionIndex) {
      const index = portionIndex as number;
      if (index < 0 || index >= rawPortions.length) {
        const description = describeFood(food);
        throw new Error(
          `portionIndex ${index} is out of range for ${description}. Call list_portions to see valid indices.`
        );
      }
      const portion = getRecord(rawPortions[index]);
      if (!portion) {
        const description = describeFood(food);
        throw new Error(
          `Portion at index ${index} is not a valid object for ${description}.`
        );
      }
      selectedPortionRecord = portion;
      resolvedIndex = index;
    }

    if (!selectedPortionRecord || resolvedIndex === undefined) {
      const description = describeFood(food);
      throw new Error(`Unable to resolve selected portion for ${description}.`);
    }

    const grams = toFiniteNumber(selectedPortionRecord.gramWeight);
    const amount = toFiniteNumber(selectedPortionRecord.amount);
    const portionDescription =
      typeof selectedPortionRecord.portionDescription === 'string' &&
      selectedPortionRecord.portionDescription.trim() !== ''
        ? selectedPortionRecord.portionDescription
        : undefined;

    const notes: string[] = [];
    if (aliasInfo) {
      notes.push(formatAliasNote(aliasInfo, food));
    }

    const missingLabels = macroNutrientKeys
      .filter((key) => !matches[key])
      .map((key) => NUTRIENT_DEFINITIONS[key].label);

    const recordMeta = getRecord(food);
    const normalizedDataType =
      typeof recordMeta?.dataType === 'string' ? recordMeta.dataType.trim().toLowerCase() : undefined;

    if (normalizedDataType === 'foundation' && missingLabels.length) {
      const description = describeFood(food);
      const aliasSuffix = aliasInfo ? ` ${formatAliasNote(aliasInfo, food)}` : '';
      const missingText = missingLabels.join(', ');
      throw new Error(
        `Foundation entry ${description} omits ${missingText}. Choose an FDC record that lists macros or derive the values manually.${aliasSuffix}`
      );
    }

    if (missingLabels.length) {
      notes.push(`Missing macro values for: ${missingLabels.join(', ')}.`);
    }

    if (grams === undefined) {
      notes.push('Selected portion is missing gramWeight; returning per-100 g macros only.');
    }

    const nutrients = macroNutrientKeys.map((key) => {
      const match = matches[key];
      const base = buildNutrientValue(key, match);

      if (grams !== undefined && base.valuePer100g !== undefined) {
        base.valuePerPortion = (base.valuePer100g * grams) / 100;
      }

      return base;
    });

    const summary = {
      fdcId: input.fdcId,
      description: describeFood(food),
      ...(dataType ? { dataType } : {}),
      ...(typeof selectedPortionRecord.id === 'number'
        ? { portionId: selectedPortionRecord.id as number }
        : {}),
      ...(resolvedIndex !== undefined ? { portionIndex: resolvedIndex } : {}),
      ...(amount !== undefined ? { amount } : {}),
      ...(portionDescription ? { portionDescription } : {}),
      ...(grams !== undefined ? { gramWeight: grams } : {}),
      ...(notes.length ? { notes } : {})
    };

    const portionHeadlineParts: string[] = [];
    for (const nutrient of nutrients) {
      if (nutrient.valuePerPortion === undefined) {
        continue;
      }
      const formatted = formatNutrientValue(nutrient.valuePerPortion, nutrient.unit);
      portionHeadlineParts.push(
        `${nutrient.label.toLowerCase()} ${formatted} ${nutrient.unit}`
      );
    }

    const portionLabel = portionDescription
      ? `${portionDescription}${grams !== undefined ? ` (${grams} g)` : ''}`
      : grams !== undefined
        ? `${grams} g`
        : 'selected portion';

    const headline =
      portionHeadlineParts.length && grams !== undefined
        ? `Macros for ${portionLabel} of ${summary.description}: ${portionHeadlineParts.join(', ')}.`
        : `Per-100 g macros for ${summary.description}: ${describeMacroSummary(
            extractMacroSummary(food)
          )}`;

    return {
      content: [
        {
          type: 'text',
          text: headline
        }
      ],
      structuredContent: {
        summary,
        nutrients
      }
    };
  }
);

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
      rateLimitPolicy: '≤1 concurrent USDA call, ≥400ms spacing, 2 retries'
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

    const initialFoods = await client.getFoods({
      fdcIds: input.fdcIds,
      format: input.format,
      nutrients: input.nutrients
    });

    let combinedFoods = dedupeFoodsByFdcId(initialFoods);

    const returnedIds = new Set<number>();
    for (const food of combinedFoods) {
      const fdcId = extractFdcId(food);
      if (typeof fdcId === 'number') {
        returnedIds.add(fdcId);
      }
    }

    const fulfilledIds = new Set<number>(
      input.fdcIds.filter((id) => returnedIds.has(id))
    );

    const missingFdcIds = input.fdcIds.filter((id) => !returnedIds.has(id));
    const aliasOptions: FoodQueryOptions = {
      format: input.format,
      nutrients: input.nutrients
    };
    let aliasNotes: string[] = [];
    const aliasFulfillmentByFdcId = new Map<number, number[]>();

    if (missingFdcIds.length) {
      const aliasResult = await hydrateAliasesForBulk(missingFdcIds, aliasOptions);
      if (aliasResult.foods.length) {
        combinedFoods = dedupeFoodsByFdcId([...combinedFoods, ...aliasResult.foods]);
      }
      if (aliasResult.resolved.length) {
        aliasNotes = aliasResult.resolved.map((entry) => formatAliasNote(entry.info, entry.food));
        for (const entry of aliasResult.resolved) {
          fulfilledIds.add(entry.info.requestedId);
          const aliasId = extractFdcId(entry.food);
          if (aliasId !== undefined) {
            const pending = aliasFulfillmentByFdcId.get(aliasId) ?? [];
            pending.push(entry.info.requestedId);
            aliasFulfillmentByFdcId.set(aliasId, pending);
          }
        }
      }
    }

    const summaries = combinedFoods.map((food) => toFoodSummary(food, aliasFulfillmentByFdcId));
    const previewSummaries = summaries.slice(0, sampleSize);
    const unresolvedIds = input.fdcIds.filter((id) => !fulfilledIds.has(id));

    const notes: string[] = [];
    if (aliasNotes.length) {
      notes.push(...aliasNotes);
    }
    if (unresolvedIds.length) {
      const preview = unresolvedIds.slice(0, 5).join(', ');
      notes.push(
        unresolvedIds.length > 5
          ? `USDA did not return ${unresolvedIds.length} requested IDs (${preview}…).`
          : `USDA did not return: ${preview}.`
      );
    }
    if (previewOnly) {
      notes.push(`Preview mode enabled; returning ${previewSummaries.length} summaries.`);
    }
    if (!includeRaw) {
      notes.push('Full USDA payload omitted to conserve context. Set includeRaw=true to include it.');
    }

    const summary = {
      requested: input.fdcIds.length,
      returned: previewOnly ? previewSummaries.length : combinedFoods.length,
      ...(previewOnly ? { previewOnly: true } : {}),
      ...(notes.length ? { notes } : {})
    };

    const examples = previewSummaries.slice(0, 3).map((food) => food.description).join('; ');
    const lines = [
      `Retrieved ${previewOnly ? previewSummaries.length : combinedFoods.length} of ${input.fdcIds.length} requested foods.`,
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
        ...(includeRaw ? { foods: combinedFoods } : {})
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
      rateLimitPolicy: '≤1 concurrent USDA call, ≥400ms spacing, 2 retries'
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
  unit: NutrientUnit;
  valuePer100g?: number;
  valuePerPortion?: number;
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
  if (keys.length === 0) {
    return {};
  }

  const pending = new Set<NutrientKey>(keys);
  const results: Partial<Record<NutrientKey, NutrientMatch>> = {};
  const record = getRecord(food);
  const nutrients = Array.isArray(record?.foodNutrients) ? record?.foodNutrients : [];

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

  if (pending.size > 0 && record) {
    const labelNutrients = getRecord(record.labelNutrients);
    if (labelNutrients) {
      const lookup = buildLabelNutrientLookup(labelNutrients);
      for (const key of Array.from(pending)) {
        const candidates = LABEL_NUTRIENT_CANDIDATES[key];
        for (const candidate of candidates) {
          const labelEntry = lookup(candidate);
          const amount = resolveLabelNutrientAmount(labelEntry);
          if (amount === undefined) {
            continue;
          }
          results[key] = {
            value: amount
          };
          pending.delete(key);
          break;
        }
      }
    }
  }

  return results;
}

function buildLabelNutrientLookup(labelNutrients: Record<string, unknown>): (candidate: string) => unknown {
  const entries = new Map<string, unknown>();
  for (const [rawKey, value] of Object.entries(labelNutrients)) {
    if (typeof rawKey !== 'string') {
      continue;
    }
    const lower = rawKey.toLowerCase();
    const normalized = normalizeLabelKey(rawKey);
    if (!entries.has(rawKey)) {
      entries.set(rawKey, value);
    }
    if (!entries.has(lower)) {
      entries.set(lower, value);
    }
    if (!entries.has(normalized)) {
      entries.set(normalized, value);
    }
  }

  return (candidate: string) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      return undefined;
    }
    const lower = candidate.toLowerCase();
    const normalized = normalizeLabelKey(candidate);
    return entries.get(candidate) ?? entries.get(lower) ?? entries.get(normalized);
  };
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
): Promise<{ food: FoodItem; matches: Partial<Record<NutrientKey, NutrientMatch>>; aliasInfo?: AliasResolution }> {
  const nutrientIds = new Set<number>();
  for (const key of keys) {
    for (const id of NUTRIENT_DEFINITIONS[key].ids) {
      nutrientIds.add(id);
    }
  }

  const attempts: FoodQueryOptions[] = [];
  const attemptSignatures = new Set<string>();
  const addAttempt = (options: FoodQueryOptions): void => {
    const normalized: FoodQueryOptions = {
      ...(options.format ? { format: options.format } : {})
    };
    if (options.nutrients && options.nutrients.length) {
      normalized.nutrients = [...options.nutrients];
    }
    const signature = buildNutrientRequestSignature(normalized);
    if (attemptSignatures.has(signature)) {
      return;
    }
    attemptSignatures.add(signature);
    attempts.push(normalized);
  };

  if (nutrientIds.size) {
    const sortedNutrients = Array.from(nutrientIds).sort((a, b) => a - b);
    addAttempt({
      format: 'abridged',
      nutrients: sortedNutrients
    });
  }

  addAttempt({ format: 'full' });
  addAttempt({ format: 'abridged' });

  if (!attempts.length) {
    addAttempt({ format: 'abridged' });
  }

  let aliasInfo: AliasResolution | undefined;
  let lastResult: { food: FoodItem; matches: Partial<Record<NutrientKey, NutrientMatch>> } | undefined;

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];

    let fetched: { food: FoodItem; resolvedFdcId: number; aliasInfo?: AliasResolution };
    try {
      fetched = await fetchFoodWithAlias(fdcId, attempt);
    } catch (error) {
      if (
        attempt.nutrients &&
        attempt.nutrients.length > 0 &&
        error instanceof FoodDataCentralError &&
        error.status === 400
      ) {
        // USDA rejects long nutrient filter lists (>~30 IDs). Skip this attempt and
        // fall back to the unfiltered/full retries already queued.
        continue;
      }
      throw error;
    }

    if (!aliasInfo && fetched.aliasInfo) {
      aliasInfo = fetched.aliasInfo;
    }

    const matches = collectNutrients(fetched.food, keys);
    lastResult = { food: fetched.food, matches };
    const hasAllMatches = hasAllNutrientMatches(matches, keys);
    const isLastAttempt = index === attempts.length - 1;

    if (hasAllMatches || isLastAttempt) {
      return {
        food: fetched.food,
        matches,
        aliasInfo
      };
    }
  }

  if (lastResult) {
    return {
      food: lastResult.food,
      matches: lastResult.matches,
      aliasInfo
    };
  }

  throw new Error(`Unable to fetch nutrient data for FDC ${fdcId}.`);
}

function buildNutrientRequestSignature(options: FoodQueryOptions): string {
  const format = options.format ?? 'default';
  const nutrientIds = Array.isArray(options.nutrients)
    ? [...options.nutrients].sort((a, b) => a - b)
    : [];
  return `${format}:${nutrientIds.join(',')}`;
}

function hasAllNutrientMatches(
  matches: Partial<Record<NutrientKey, NutrientMatch>>,
  keys: NutrientKey[]
): boolean {
  return keys.every((key) => matches[key] !== undefined);
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
  return `${formatNutrientValue(nutrient.valuePer100g, nutrient.unit)} ${nutrient.unit}`;
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
      const { food, matches, aliasInfo } = await fetchFoodForNutrients(input.fdcId, [config.key]);
      const nutrientMatch = matches[config.key];
      const nutrientValue = buildNutrientValue(config.key, nutrientMatch);
      const notes: string[] = [];
      if (aliasInfo) {
        notes.push(formatAliasNote(aliasInfo, food));
      }
      if (nutrientValue.valuePer100g === undefined) {
        notes.push(`${definition.label} not available for this entry.`);
      }
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

function resolveLabelNutrientAmount(entry: unknown): number | undefined {
  if (entry === undefined || entry === null) {
    return undefined;
  }

  if (typeof entry === 'number' || typeof entry === 'string') {
    return toFiniteNumber(entry);
  }

  if (typeof entry === 'object') {
    const base = entry as Record<string, unknown>;
    return toFiniteNumber(base.value ?? base.amount ?? base.perServing ?? base.per100g);
  }

  return undefined;
}

function normalizeLabelKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

async function fetchFoodWithAlias(
  fdcId: number,
  options?: FoodQueryOptions
): Promise<{ food: FoodItem; resolvedFdcId: number; aliasInfo?: AliasResolution }> {
  try {
    const food = await client.getFood(fdcId, options);
    return { food, resolvedFdcId: fdcId };
  } catch (error) {
    if (error instanceof FoodDataCentralError && error.status === 404) {
      const alias = resolveFdcAlias(fdcId);
      if (alias) {
        const food = await client.getFood(alias.replacementId, options);
        return {
          food,
          resolvedFdcId: alias.replacementId,
          aliasInfo: {
            requestedId: fdcId,
            alias
          }
        };
      }
    }
    throw error;
  }
}

function resolveFdcAlias(fdcId: number): FdcIdAlias | undefined {
  return FDC_ID_ALIASES.get(fdcId);
}

function formatAliasNote(info: AliasResolution, aliasFood: FoodItem): string {
  const aliasDescription = describeFood(aliasFood);
  const datasetSuffix = info.alias.dataset ? ` (${info.alias.dataset})` : '';
  const rationale = info.alias.rationale ? ` ${info.alias.rationale}` : '';
  return `FDC ${info.requestedId} not returned by USDA; substituted ${aliasDescription}${datasetSuffix}.${rationale}`.trim();
}

type ResolvedAliasFood = {
  info: AliasResolution;
  food: FoodItem;
};

async function hydrateAliasesForBulk(
  missingIds: number[],
  options?: FoodQueryOptions
): Promise<{ foods: FoodItem[]; resolved: ResolvedAliasFood[] }> {
  if (!missingIds.length) {
    return { foods: [], resolved: [] };
  }

  const aliasRequests = missingIds
    .map((requestedId) => {
      const alias = resolveFdcAlias(requestedId);
      return alias ? { requestedId, alias } : undefined;
    })
    .filter((value): value is { requestedId: number; alias: FdcIdAlias } => Boolean(value));

  if (!aliasRequests.length) {
    return { foods: [], resolved: [] };
  }

  const aliasIds = Array.from(
    new Set(aliasRequests.map((entry) => entry.alias.replacementId))
  );

  const aliasFoods = await client.getFoods({
    fdcIds: aliasIds,
    format: options?.format,
    nutrients: options?.nutrients
  });

  const aliasFoodById = new Map<number, FoodItem>();
  for (const aliasFood of aliasFoods) {
    const aliasId = extractFdcId(aliasFood);
    if (aliasId !== undefined && !aliasFoodById.has(aliasId)) {
      aliasFoodById.set(aliasId, aliasFood);
    }
  }

  const resolved: ResolvedAliasFood[] = [];
  for (const request of aliasRequests) {
    const aliasFood = aliasFoodById.get(request.alias.replacementId);
    if (aliasFood) {
      resolved.push({
        info: {
          requestedId: request.requestedId,
          alias: request.alias
        },
        food: aliasFood
      });
    }
  }

  return { foods: aliasFoods, resolved };
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

function formatNutrientValue(value: number, unit: NutrientUnit): string {
  switch (unit) {
    case 'kcal':
      return Math.round(value).toString();
    case 'g':
      return formatDecimal(value, 2);
    case 'mg':
      return formatDecimal(value, 1);
    case 'mcg':
      return Math.round(value).toString();
    default:
      return value.toString();
  }
}

function formatDecimal(value: number, decimals: number): string {
  const factor = 10 ** decimals;
  return (Math.round(value * factor) / factor).toString();
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
  requestedFdcIds?: number[];
  macros?: MacroSummary;
};

type SearchPreview = {
  fdcId: number;
  description: string;
  dataType?: string;
  brandOwner?: string;
};

function toFoodSummary(food: FoodItem, aliasFulfillment?: Map<number, number[]>): FoodSummary {
  const macros = extractMacroSummary(food);
  const fdcId = extractFdcId(food);
  const record = getRecord(food);
  const dataType = typeof record?.dataType === 'string' ? record.dataType : undefined;
  const brandOwner = typeof record?.brandOwner === 'string' ? record.brandOwner : undefined;
  const publishedDate =
    typeof record?.publishedDate === 'string' ? record.publishedDate : undefined;
  const requestedIds =
    typeof fdcId === 'number' ? aliasFulfillment?.get(fdcId) : undefined;
  const normalizedRequestedIds =
    requestedIds && requestedIds.length
      ? Array.from(new Set(requestedIds)).sort((a, b) => a - b)
      : undefined;

  return {
    description: describeFood(food),
    ...(fdcId !== undefined ? { fdcId } : {}),
    ...(dataType ? { dataType } : {}),
    ...(brandOwner ? { brandOwner } : {}),
    ...(publishedDate ? { publishedDate } : {}),
    ...(normalizedRequestedIds ? { requestedFdcIds: normalizedRequestedIds } : {}),
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

function dedupeFoodsByFdcId(foods: FoodItem[]): FoodItem[] {
  const seen = new Set<number>();
  const deduped: FoodItem[] = [];
  for (const food of foods) {
    const fdcId = extractFdcId(food);
    if (fdcId !== undefined && seen.has(fdcId)) {
      continue;
    }
    deduped.push(food);
    if (fdcId !== undefined) {
      seen.add(fdcId);
    }
  }
  return deduped;
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
    '- Request policy: up to 1 concurrent USDA call with ≥400ms spacing and up to 2 exponential backoff retries on HTTP 429/5xx or timeouts.',
    '- Timeout: Each request aborts after 30s to keep the server responsive.',
    '',
    describeEnvironmentOverride(),
    '',
    'Set USDA_API_BASE_URL to point at a proxy or alternate API host when needed.'
  ].join('\n');
}
