import { USDA_API_BASE_URL, getRequiredApiKey } from './config.js';

type QueryValue = string | number | boolean | Array<string | number | boolean>;

const DEFAULT_TIMEOUT_MS = 30_000;

const enum HttpMethod {
  GET = 'GET',
  POST = 'POST'
}

export type FoodDataType =
  | 'Branded'
  | 'Survey (FNDDS)'
  | 'SR Legacy'
  | 'Foundation'
  | 'Experimental';

export interface SearchFoodsRequest {
  query: string;
  dataType?: FoodDataType[];
  pageNumber?: number;
  pageSize?: number;
  sortBy?: 'dataType.keyword' | 'lowercaseDescription.keyword' | 'publishedDate';
  sortOrder?: 'asc' | 'desc';
  brandOwner?: string;
  requireAllWords?: boolean;
  ingredients?: string;
  nutrients?: number[];
}

export interface ListFoodsRequest {
  dataType?: FoodDataType[];
  pageNumber?: number;
  pageSize?: number;
  sortBy?: 'dataType.keyword' | 'lowercaseDescription.keyword' | 'publishedDate';
  sortOrder?: 'asc' | 'desc';
  brandOwner?: string;
}

export interface BulkFoodsRequest {
  fdcIds: number[];
  format?: 'abridged' | 'full';
  nutrients?: number[];
}

export interface FoodQueryOptions {
  format?: 'abridged' | 'full';
  nutrients?: number[];
}

export interface SearchFoodsResponse {
  foods: FoodItem[];
  totalHits: number;
  currentPage: number;
  totalPages: number;
  pageList: number[];
}

export type ListFoodsResponse = FoodItem[];

export type FoodItem = Record<string, unknown>;

export class FoodDataCentralClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string;

  constructor(options?: { baseUrl?: string; apiKey?: string }) {
    this.baseUrl = new URL(options?.baseUrl ?? USDA_API_BASE_URL);
    this.apiKey = options?.apiKey ?? getRequiredApiKey();
  }

  async searchFoods(params: SearchFoodsRequest): Promise<SearchFoodsResponse> {
    const payload = pruneUndefined({
      ...params,
      pageNumber: params.pageNumber,
      pageSize: params.pageSize
    });

    return this.post<SearchFoodsResponse>('foods/search', payload);
  }

  async getFood(fdcId: number, options?: FoodQueryOptions): Promise<FoodItem> {
    return this.get<FoodItem>(`food/${fdcId}`, {
      ...(options?.format ? { format: options.format } : undefined),
      ...(options?.nutrients ? { nutrients: options.nutrients } : undefined)
    });
  }

  async getFoods(params: BulkFoodsRequest): Promise<FoodItem[]> {
    const payload = pruneUndefined({
      fdcIds: params.fdcIds,
      format: params.format,
      nutrients: params.nutrients
    });

    return this.post<FoodItem[]>('foods', payload);
  }

  async listFoods(params: ListFoodsRequest): Promise<ListFoodsResponse> {
    const payload = pruneUndefined({
      dataType: params.dataType,
      pageNumber: params.pageNumber,
      pageSize: params.pageSize,
      sortBy: params.sortBy,
      sortOrder: params.sortOrder,
      brandOwner: params.brandOwner
    });

    return this.post<ListFoodsResponse>('foods/list', payload);
  }

  private async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>(path, { method: HttpMethod.GET, query });
  }

  private async post<T>(path: string, body: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>(path, {
      method: HttpMethod.POST,
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json'
      },
      query
    });
  }

  private async request<T>(
    path: string,
    init: {
      method: HttpMethod;
      headers?: Record<string, string>;
      body?: string;
      query?: Record<string, QueryValue>;
      timeoutMs?: number;
    }
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set('api_key', this.apiKey);

    if (init.query) {
      for (const [key, value] of Object.entries(init.query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            url.searchParams.append(key, String(item));
          }
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await safeReadText(response);
        throw new Error(
          `FoodData Central request failed: ${response.status} ${response.statusText}${
            errorText ? ` - ${errorText}` : ''
          }`
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('FoodData Central request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function safeReadText(response: { text: () => Promise<string> }): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    return '';
  }
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
  ) as T;
}
