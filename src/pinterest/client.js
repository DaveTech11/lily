import axios from "axios";
import { config } from "../config.js";
import { withRetry } from "../utils/retry.js";
import { logger } from "../utils/logger.js";

const officialApi = axios.create({
  baseURL: config.pinterest.baseUrl,
  timeout: 20000,
  headers: {
    Authorization: config.pinterest.accessToken ? `Bearer ${config.pinterest.accessToken}` : undefined,
    Accept: "application/json"
  }
});

const rebixApi = axios.create({
  baseURL: config.pinterest.endpoint,
  timeout: 25000,
  headers: { Accept: "application/json" }
});

function isRetryable(error) {
  const status = error?.response?.status;
  return !status || status === 408 || status === 429 || status >= 500;
}

export async function searchPins(term) {
  if (config.pinterest.provider === "rebix") {
    return withRetry(async () => {
      const response = await rebixApi.get("", { params: { q: term } });
      const data = response.data;
      const items = Array.isArray(data) ? data : (data?.items || data?.results || data?.data || []);
      if (!Array.isArray(items)) throw new Error("Pinterest endpoint returned an unexpected response format");
      return items;
    }, {
      retries: config.content.maxRetries,
      shouldRetry: isRetryable,
      onRetry: async (error, attempt, delay) => {
        logger.warn({ status: error?.response?.status, attempt, delay, term }, "Pinterest endpoint retrying");
      }
    });
  }

  if (!config.pinterest.accessToken) {
    throw new Error("PINTEREST_ACCESS_TOKEN is required when PINTEREST_PROVIDER=official");
  }

  return withRetry(async () => {
    const response = await officialApi.get("/search/partner/pins", {
      params: {
        term,
        country_code: config.pinterest.countryCode,
        locale: config.pinterest.locale,
        limit: config.content.searchResultsPerQuery
      }
    });
    return response.data?.items || [];
  }, {
    retries: config.content.maxRetries,
    shouldRetry: isRetryable,
    onRetry: async (error, attempt, delay) => {
      logger.warn({ status: error?.response?.status, attempt, delay, term }, "Pinterest request retrying");
    }
  });
}
