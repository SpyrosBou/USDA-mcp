const API_KEY_ENV_VAR = 'USDA_API_KEY';
const BASE_URL_ENV_VAR = 'USDA_API_BASE_URL';

const configuredBaseUrl = process.env[BASE_URL_ENV_VAR];

export const USDA_API_BASE_URL = configuredBaseUrl
  ? ensureTrailingSlash(configuredBaseUrl)
  : 'https://api.nal.usda.gov/fdc/v1/';

export function getApiKey(): string {
  const value = process.env[API_KEY_ENV_VAR];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Missing USDA API key. Set ${API_KEY_ENV_VAR} in your environment (e.g., via MCP config env.USDA_API_KEY) before starting the server.`
    );
  }
  return value;
}

export function describeEnvironmentOverride(): string {
  return `Required: set ${API_KEY_ENV_VAR} with your USDA FoodData Central API key before starting the MCP server.`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
