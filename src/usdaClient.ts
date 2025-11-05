import { USDA_API_BASE_URL, getApiKey } from './config.js';

type QueryValue = string | number | boolean | Array<string | number | boolean>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 750;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 1;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 400;

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
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options?: { status?: number; responseBody?: string; retryable?: boolean; retryAfterMs?: number; cause?: unknown }
  ) {
    super(message);
    this.name = 'FoodDataCentralError';
    this.status = options?.status;
    this.responseBody = options?.responseBody;
    this.retryable = options?.retryable ?? false;
    this.retryAfterMs = options?.retryAfterMs;
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
    const foods = await this.getFoods({
      fdcIds: [fdcId],
      format: options?.format,
      nutrients: options?.nutrients
    });

    const food = foods[0];
    if (!food) {
      throw new FoodDataCentralError(`FDC ID ${fdcId} not found`, {
        status: 404,
        retryable: false
      });
    }

    return food;
  }

  async getFoods(params: BulkFoodsRequest): Promise<FoodItem[]> {
    const payload = pruneUndefined({
      fdcIds: params.fdcIds,
      format: params.format ?? 'abridged',
      nutrients: params.nutrients
    });

    const response = await this.post<unknown>('foods', payload);
    return normalizeBulkFoodsResponse(response);
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
        const retryAfterMs = parseRetryAfterMs(response.headers);
        const bodyDetails = parseUsdaErrorBody(errorText);
        const enhancedMessage = describeHttpFailure(response.status, response.statusText, retryAfterMs, bodyDetails);
        throw new FoodDataCentralError(
          enhancedMessage,
          {
            status: response.status,
            responseBody: errorText,
            retryable: isRetryableStatus(response.status),
            retryAfterMs
          }
        );
      }

      const data = (await response.json()) as unknown;
      const bodyError = detectUsdaErrorEnvelope(data, response.status);
      if (bodyError) {
        throw new FoodDataCentralError(bodyError.message, {
          status: bodyError.status ?? response.status,
          responseBody: safeSerialize(bodyError.rawPayload),
          retryable: bodyError.retryable,
          retryAfterMs: bodyError.retryAfterMs
        });
      }

      return data as T;
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

function normalizeBulkFoodsResponse(response: unknown): FoodItem[] {
  if (Array.isArray(response)) {
    return response as FoodItem[];
  }

  if (isRecord(response)) {
    const foods = response.foods;
    if (Array.isArray(foods)) {
      return foods as FoodItem[];
    }

    if (isRecord(response.error)) {
      const code = typeof response.error.code === 'string' ? response.error.code : undefined;
      const message = typeof response.error.message === 'string' ? response.error.message : 'USDA error response';
      throw new FoodDataCentralError(code ? `USDA error ${code}: ${message}` : message, {
        retryable: code === 'OVER_RATE_LIMIT',
        responseBody: safeSerialize(response)
      });
    }

    if (Object.keys(response).length === 0) {
      return [];
    }
  }

  throw new FoodDataCentralError('Unexpected USDA bulk foods response format', {
    responseBody: safeSerialize(response),
    retryable: false
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeSerialize(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') {
      return '';
    }
    return serialized.length > 2000 ? `${serialized.slice(0, 2000)}…` : serialized;
  } catch (error) {
    return error instanceof Error ? error.message : '';
  }
}

function parseRetryAfterMs(headers: { get(name: string): string | null }): number | undefined {
  const header = headers.get('Retry-After');
  if (!header) {
    return undefined;
  }

  const seconds = Number(header);
  if (!Number.isNaN(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(header);
  if (Number.isNaN(date)) {
    return undefined;
  }

  return Math.max(0, date - Date.now());
}

function parseUsdaErrorBody(payload: string): { code?: string; message?: string } | undefined {
  if (!payload) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(payload);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const code = typeof parsed.error.code === 'string' ? parsed.error.code : undefined;
      const message = typeof parsed.error.message === 'string' ? parsed.error.message : undefined;
      return { code, message };
    }
  } catch {
    // fall through
  }

  return undefined;
}

function detectUsdaErrorEnvelope(
  payload: unknown,
  fallbackStatus?: number
): { message: string; status?: number; retryable: boolean; rawPayload: unknown; retryAfterMs?: number } | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  if (!isRecord(payload.error)) {
    return undefined;
  }

  const code = typeof payload.error.code === 'string' ? payload.error.code : undefined;
  const message =
    typeof payload.error.message === 'string'
      ? payload.error.message
      : typeof payload.error.description === 'string'
        ? payload.error.description
        : 'FoodData Central request failed.';

  const status =
    typeof payload.error.status === 'number'
      ? payload.error.status
      : typeof payload.error.httpStatus === 'number'
        ? payload.error.httpStatus
        : undefined;

  const effectiveStatus = status ?? fallbackStatus;
  const retryable =
    code === 'OVER_RATE_LIMIT' ||
    (typeof effectiveStatus === 'number' ? isRetryableStatus(effectiveStatus) : false);

  return {
    message: code ? `USDA error ${code}: ${message}` : message,
    status: effectiveStatus,
    retryable,
    rawPayload: payload
  };
}

function describeHttpFailure(
  status: number,
  statusText: string,
  retryAfterMs: number | undefined,
  bodyDetails: { code?: string; message?: string } | undefined
): string {
  const parts = [`FoodData Central request failed: ${status} ${statusText}`];
  if (bodyDetails?.code || bodyDetails?.message) {
    parts.push(
      ['USDA', bodyDetails.code].filter(Boolean).join(' '),
      bodyDetails.message ?? ''
    );
  }
  if (retryAfterMs !== undefined) {
    parts.push(`Retry after ${formatDurationMs(retryAfterMs)}.`);
  }
  return parts.filter(Boolean).join(' — ');
}

function formatDurationMs(value: number): string {
  const seconds = Math.ceil(Math.max(0, value) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
