const API_KEY_ENV_VAR = 'USDA_API_KEY';
const BASE_URL_ENV_VAR = 'USDA_API_BASE_URL';
const DEFAULT_API_KEY = 'LGsANckDFfgjdeiLKhQWbzh2sYgwbG0Az16I902m';

const configuredBaseUrl = process.env[BASE_URL_ENV_VAR];

export const USDA_API_BASE_URL = configuredBaseUrl
  ? ensureTrailingSlash(configuredBaseUrl)
  : 'https://api.nal.usda.gov/fdc/v1/';

export function getApiKey(): string {
  return process.env[API_KEY_ENV_VAR] ?? DEFAULT_API_KEY;
}

export function describeEnvironmentOverride(): string {
  return `Optional: set ${API_KEY_ENV_VAR} to override the baked-in FoodData Central API key.`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
