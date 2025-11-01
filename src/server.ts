import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z, type ZodRawShape } from 'zod';

import {
  FoodDataCentralClient,
  FoodItem,
  FoodQueryOptions,
  ListFoodsRequest,
  SearchFoodsRequest
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
    version: '0.1.0'
  },
  {
    instructions: serverInstructions
  }
);

server.server.registerCapabilities({
  logging: {}
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

const foodSummaryShape = {
  description: z.string(),
  fdcId: z.number().optional(),
  macros: macroSummarySchema.optional()
} satisfies ZodRawShape;

const foodSummarySchema = z.object(foodSummaryShape).strict();

const searchFoodsOutputShape = {
  results: z
    .object({
      foods: z.array(foodItemSchema),
      totalHits: z.number(),
      currentPage: z.number(),
      totalPages: z.number(),
      pageList: z.array(z.number())
    })
    .passthrough(),
  summaries: z.array(foodSummarySchema)
} satisfies ZodRawShape;

const getFoodOutputShape = {
  food: foodItemSchema,
  macros: macroSummarySchema.optional()
} satisfies ZodRawShape;

const bulkFoodsOutputShape = {
  foods: z.array(foodItemSchema),
  summaries: z.array(foodSummarySchema)
} satisfies ZodRawShape;

server.registerTool(
  'search-foods',
  {
    title: 'Search Foods',
    description:
      'Full-text search of USDA FoodData Central; best when you need discovery across brands or ingredients. Supports pagination, sorting, data type filters, macro nutrient ID filters, and brand owner narrowing. Returns structured summaries and the raw API payload.',
    inputSchema: {
      query: z.string().min(1, 'Query is required'),
      dataType: z.array(foodDataTypeSchema).max(5).optional(),
      pageNumber: z.number().int().min(1).max(200).optional(),
      pageSize: z.number().int().min(1).max(200).optional(),
      sortBy: z.enum(['dataType.keyword', 'lowercaseDescription.keyword', 'publishedDate']).optional(),
      sortOrder: z.enum(['asc', 'desc']).optional(),
      brandOwner: z.string().min(1).optional(),
      requireAllWords: z.boolean().optional(),
      ingredients: z.string().min(1).optional(),
      nutrients: nutrientIdsSchema.optional()
    },
    outputSchema: searchFoodsOutputShape
  },
  async (input) => {
    const params: SearchFoodsRequest = {
      query: input.query,
      dataType: input.dataType,
      pageNumber: input.pageNumber,
      pageSize: input.pageSize,
      sortBy: input.sortBy,
      sortOrder: input.sortOrder,
      brandOwner: input.brandOwner,
      requireAllWords: input.requireAllWords,
      ingredients: input.ingredients,
      nutrients: input.nutrients
    };

    const results = await client.searchFoods(params);
    const summary = `Search "${input.query}" matched ${results.totalHits} foods (showing page ${results.currentPage} of ${results.totalPages}).`;
    const summaries = Array.isArray(results.foods)
      ? results.foods.map((food) => toFoodSummary(food))
      : [];

    return {
      content: [
        {
          type: 'text',
          text: summary
        }
      ],
      structuredContent: {
        results,
        summaries
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
    inputSchema: {
      fdcId: z.number().int().positive(),
      format: z.enum(['abridged', 'full']).optional(),
      nutrients: nutrientIdsSchema.optional()
    },
    outputSchema: getFoodOutputShape
  },
  async (input) => {
    const options: FoodQueryOptions = {
      format: input.format,
      nutrients: input.nutrients
    };

    const food = await client.getFood(input.fdcId, options);
    const macros = extractMacroSummary(food);
    const macroHeadline = describeMacroSummary(macros);

    return {
      content: [
        {
          type: 'text',
          text: [`Fetched food ${describeFood(food)}.`, macroHeadline].filter(Boolean).join(' ')
        }
      ],
      structuredContent: {
        food,
        ...(macros ? { macros } : {})
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
    inputSchema: {
      fdcIds: z.array(z.number().int().positive()).min(1).max(50),
      format: z.enum(['abridged', 'full']).optional(),
      nutrients: nutrientIdsSchema.optional()
    },
    outputSchema: bulkFoodsOutputShape
  },
  async (input) => {
    const foods = await client.getFoods({
      fdcIds: input.fdcIds,
      format: input.format,
      nutrients: input.nutrients
    });

    const preview = foods.slice(0, 3).map((food) => describeFood(food)).join('; ');
    const summary = `Fetched ${foods.length} foods. ${preview ? `Examples: ${preview}.` : ''}`;

    const summaries = foods.map((food) => toFoodSummary(food));

    return {
      content: [
        {
          type: 'text',
          text: summary.trim()
        }
      ],
      structuredContent: {
        foods,
        summaries
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
    inputSchema: {
      dataType: z.array(foodDataTypeSchema).max(5).optional(),
      pageNumber: z.number().int().min(1).max(200).optional(),
      pageSize: z.number().int().min(1).max(200).optional(),
      sortBy: z.enum(['dataType.keyword', 'lowercaseDescription.keyword', 'publishedDate']).optional(),
      sortOrder: z.enum(['asc', 'desc']).optional(),
      brandOwner: z.string().min(1).optional()
    },
    outputSchema: bulkFoodsOutputShape
  },
  async (input) => {
    const params: ListFoodsRequest = {
      dataType: input.dataType,
      pageNumber: input.pageNumber,
      pageSize: input.pageSize,
      sortBy: input.sortBy,
      sortOrder: input.sortOrder,
      brandOwner: input.brandOwner
    };

    const foods = await client.listFoods(params);
    const headline = foods.length ? foods.slice(0, 3).map((food) => describeFood(food)).join('; ') : 'No foods returned.';
    const summary = `Retrieved ${foods.length} foods. ${headline}`;
    const summaries = foods.map((food) => toFoodSummary(food));

    return {
      content: [
        {
          type: 'text',
          text: summary.trim()
        }
      ],
      structuredContent: {
        foods,
        summaries
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

const MACRO_NUTRIENT_IDS: Record<keyof MacroSummary, ReadonlySet<number>> = {
  calories: new Set([1008, 208]),
  protein: new Set([1003, 203]),
  fat: new Set([1004, 204]),
  carbs: new Set([1005, 205])
};

function extractMacroSummary(food: FoodItem): MacroSummary | undefined {
  const nutrients = (food as Record<string, unknown>)?.foodNutrients;
  if (!Array.isArray(nutrients)) {
    return undefined;
  }

  const summary: MacroSummary = {};

  for (const entry of nutrients) {
    const nutrientId = resolveNutrientId(entry);
    if (nutrientId === undefined) {
      continue;
    }

    const amount = resolveNutrientAmount(entry);
    if (amount === undefined) {
      continue;
    }

    if (MACRO_NUTRIENT_IDS.calories.has(nutrientId)) {
      summary.calories ??= amount;
    } else if (MACRO_NUTRIENT_IDS.protein.has(nutrientId)) {
      summary.protein ??= amount;
    } else if (MACRO_NUTRIENT_IDS.fat.has(nutrientId)) {
      summary.fat ??= amount;
    } else if (MACRO_NUTRIENT_IDS.carbs.has(nutrientId)) {
      summary.carbs ??= amount;
    }
  }

  return Object.values(summary).some((value) => value !== undefined) ? summary : undefined;
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
  macros?: MacroSummary;
};

function toFoodSummary(food: FoodItem): FoodSummary {
  const macros = extractMacroSummary(food);
  const fdcId = extractFdcId(food);

  return {
    description: describeFood(food),
    ...(fdcId !== undefined ? { fdcId } : {}),
    ...(macros ? { macros } : {})
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
