import "dotenv/config";
import path from "node:path";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

const root = process.cwd();

export const config = {
  telegram: {
    token: required("TELEGRAM_BOT_TOKEN"),
    channelId: required("TELEGRAM_CHANNEL_ID")
  },
  pinterest: {
    provider: (process.env.PINTEREST_PROVIDER || "rebix").toLowerCase(),
    accessToken: process.env.PINTEREST_ACCESS_TOKEN?.trim() || "",
    countryCode: process.env.PINTEREST_COUNTRY_CODE || "NG",
    locale: process.env.PINTEREST_LOCALE || "en-US",
    baseUrl: "https://api.pinterest.com/v5",
    endpoint: process.env.PINTEREST_ENDPOINT || "https://api-rebix.zone.id/api/pinterest"
  },
  schedule: {
    intervalSeconds: intEnv("POST_INTERVAL", 3600),
    runOnStart: boolEnv("RUN_ON_START", false)
  },
  content: {
    imagesPerPost: Math.min(Math.max(intEnv("IMAGES_PER_POST", 1), 1), 10),
    searchResultsPerQuery: Math.min(Math.max(intEnv("SEARCH_RESULTS_PER_QUERY", 20), 1), 50),
    minWidth: intEnv("MIN_IMAGE_WIDTH", 300),
    minHeight: intEnv("MIN_IMAGE_HEIGHT", 300),
    maxDownloadBytes: intEnv("MAX_DOWNLOAD_BYTES", 15_000_000),
    maxTelegramBytes: intEnv("MAX_TELEGRAM_IMAGE_BYTES", 9_500_000),
    maxRetries: Math.min(Math.max(intEnv("MAX_RETRIES", 3), 1), 8),
    requireSourceLink: boolEnv("REQUIRE_SOURCE_LINK", true),
    skipSponsored: boolEnv("SKIP_SPONSORED", true),
    licensedDomains: (process.env.LICENSED_SOURCE_DOMAINS || "")
      .split(",").map(v => v.trim().toLowerCase()).filter(Boolean),
    classifierEnabled: boolEnv("ENABLE_CLASSIFIER", true)
  },
  storage: {
    databasePath: path.resolve(root, process.env.DATABASE_PATH || "./data/bot.db"),
    downloadDir: path.resolve(root, process.env.DOWNLOAD_DIR || "./downloads")
  },
  logLevel: process.env.LOG_LEVEL || "info"
};
