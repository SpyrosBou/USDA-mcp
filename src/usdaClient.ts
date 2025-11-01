import { USDA_API_BASE_URL, getApiKey } from './config.js';

type QueryValue = string | number | boolean | Array<string | number | boolean>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 750;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 250;

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

type RetryConfig = {
  maxRetries: number;
  retryDelayMs: number;
};

type RequestLimiterOptions = {
  maxConcurrent: number;
  minDelayMs: number;
};

class RequestLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private lastDispatched = 0;

  constructor(private readonly options: RequestLimiterOptions) {}

  async schedule<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    while (true) {
      if (this.active < this.options.maxConcurrent) {
        const now = Date.now();
        const elapsed = now - this.lastDispatched;
        if (elapsed < this.options.minDelayMs) {
          await delay(this.options.minDelayMs - elapsed);
          continue;
        }

        this.active += 1;
        this.lastDispatched = Date.now();
        return;
      }

      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}

export class FoodDataCentralError extends Error {
  readonly status?: number;
  readonly responseBody?: string;
  readonly retryable: boolean;

  constructor(message: string, options?: { status?: number; responseBody?: string; retryable?: boolean; cause?: unknown }) {
    super(message);
    this.name = 'FoodDataCentralError';
    this.status = options?.status;
    this.responseBody = options?.responseBody;
    this.retryable = options?.retryable ?? false;
    if (options?.cause !== undefined) {
      // Assign cause for better stack traces when supported.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export class FoodDataCentralClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string;
  private readonly retry: RetryConfig;
  private readonly limiter: RequestLimiter;
  private readonly logger?: (message: string) => void;

  constructor(options?: {
    baseUrl?: string;
    apiKey?: string;
    maxRetries?: number;
    retryDelayMs?: number;
    maxConcurrentRequests?: number;
    minRequestIntervalMs?: number;
    logger?: (message: string) => void;
  }) {
    this.baseUrl = new URL(options?.baseUrl ?? USDA_API_BASE_URL);
    this.apiKey = options?.apiKey ?? getApiKey();
    this.retry = {
      maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryDelayMs: options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    };
    this.limiter = new RequestLimiter({
      maxConcurrent: options?.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
      minDelayMs: options?.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS
    });
    this.logger = options?.logger;
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
    return this.limiter.schedule(() => this.sendWithRetries<T>(path, init));
  }

  private async sendWithRetries<T>(
    path: string,
    init: {
      method: HttpMethod;
      headers?: Record<string, string>;
      body?: string;
      query?: Record<string, QueryValue>;
      timeoutMs?: number;
    }
  ): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.retry.maxRetries) {
      try {
        return await this.sendOnce<T>(path, init);
      } catch (error) {
        lastError = error;
        if (!this.shouldRetry(error, attempt)) {
          throw error;
        }

        const backoffMs = this.computeBackoffDelay(attempt);
        this.logger?.(
          `Retrying USDA request (${attempt + 1}/${this.retry.maxRetries}) after ${backoffMs}ms due to: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        await delay(backoffMs);
        attempt += 1;
      }
    }

    throw lastError instanceof Error ? lastError : new FoodDataCentralError('FoodData Central request failed', { cause: lastError });
  }

  private async sendOnce<T>(
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
        throw new FoodDataCentralError(
          `FoodData Central request failed: ${response.status} ${response.statusText}`,
          {
            status: response.status,
            responseBody: errorText,
            retryable: isRetryableStatus(response.status)
          }
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new FoodDataCentralError('FoodData Central request timed out', { retryable: true, cause: error });
      }
      if (error instanceof FoodDataCentralError) {
        throw error;
      }
      throw new FoodDataCentralError('FoodData Central request failed', { retryable: true, cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  private shouldRetry(error: unknown, attempt: number): boolean {
    if (attempt >= this.retry.maxRetries) {
      return false;
    }

    if (error instanceof FoodDataCentralError) {
      return error.retryable;
    }

    return false;
  }

  private computeBackoffDelay(attempt: number): number {
    const base = this.retry.retryDelayMs * Math.pow(2, attempt);
    const jitter = 0.5 + Math.random(); // between 0.5x and 1.5x
    return Math.round(base * jitter);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}
