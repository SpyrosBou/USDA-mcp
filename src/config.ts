const API_KEY_ENV_VAR = 'USDA_API_KEY';
const BASE_URL_ENV_VAR = 'USDA_API_BASE_URL';

const configuredBaseUrl = process.env[BASE_URL_ENV_VAR];

export const USDA_API_BASE_URL = configuredBaseUrl
  ? ensureTrailingSlash(configuredBaseUrl)
  : 'https://api.nal.usda.gov/fdc/v1/';

export function getRequiredApiKey(): string {
  const key = process.env[API_KEY_ENV_VAR];
  if (!key) {
    throw new Error(
      `Missing USDA FoodData Central API key. Set the ${API_KEY_ENV_VAR} environment variable.`
    );
  }
  return key;
}

export function describeEnvironmentRequirements(): string {
  return `Set ${API_KEY_ENV_VAR} with your FoodData Central API key before starting the server.`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
