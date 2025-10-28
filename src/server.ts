import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { describeEnvironmentRequirements } from './config.js';
import {
  FoodDataCentralClient,
  FoodItem,
  FoodQueryOptions,
  ListFoodsRequest,
  SearchFoodsRequest
} from './usdaClient.js';

const server = new McpServer({
  name: 'usda-fooddata-central',
  version: '0.1.0'
});

let client: FoodDataCentralClient;

try {
  client = new FoodDataCentralClient();
} catch (error) {
  console.error('Unable to start USDA FoodData Central MCP server.');
  console.error(describeEnvironmentRequirements());
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
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

server.registerTool(
  'search-foods',
  {
    title: 'Search Foods',
    description: 'Search the USDA FoodData Central database using keywords and optional filters.',
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
    }
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

    return {
      content: [
        {
          type: 'text',
          text: summary
        }
      ],
      structuredContent: { results }
    };
  }
);

server.registerTool(
  'get-food',
  {
    title: 'Get Food Details',
    description: 'Retrieve detailed information for a food by its FDC ID.',
    inputSchema: {
      fdcId: z.number().int().positive(),
      format: z.enum(['abridged', 'full']).optional(),
      nutrients: nutrientIdsSchema.optional()
    }
  },
  async (input) => {
    const options: FoodQueryOptions = {
      format: input.format,
      nutrients: input.nutrients
    };

    const food = await client.getFood(input.fdcId, options);

    return {
      content: [
        {
          type: 'text',
          text: `Fetched food ${describeFood(food)}.`
        }
      ],
      structuredContent: { food }
    };
  }
);

server.registerTool(
  'get-foods',
  {
    title: 'Get Multiple Foods',
    description: 'Fetch multiple foods in a single request by providing a list of FDC IDs.',
    inputSchema: {
      fdcIds: z.array(z.number().int().positive()).min(1).max(50),
      format: z.enum(['abridged', 'full']).optional(),
      nutrients: nutrientIdsSchema.optional()
    }
  },
  async (input) => {
    const foods = await client.getFoods({
      fdcIds: input.fdcIds,
      format: input.format,
      nutrients: input.nutrients
    });

    const preview = foods.slice(0, 3).map((food) => describeFood(food)).join('; ');
    const summary = `Fetched ${foods.length} foods. ${preview ? `Examples: ${preview}.` : ''}`;

    return {
      content: [
        {
          type: 'text',
          text: summary.trim()
        }
      ],
      structuredContent: { foods }
    };
  }
);

server.registerTool(
  'list-foods',
  {
    title: 'List Foods',
    description:
      'Page through foods with optional filters by data type, brand owner, and sort options.',
    inputSchema: {
      dataType: z.array(foodDataTypeSchema).max(5).optional(),
      pageNumber: z.number().int().min(1).max(200).optional(),
      pageSize: z.number().int().min(1).max(200).optional(),
      sortBy: z.enum(['dataType.keyword', 'lowercaseDescription.keyword', 'publishedDate']).optional(),
      sortOrder: z.enum(['asc', 'desc']).optional(),
      brandOwner: z.string().min(1).optional()
    }
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

    return {
      content: [
        {
          type: 'text',
          text: summary.trim()
        }
      ],
      structuredContent: { foods }
    };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
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
