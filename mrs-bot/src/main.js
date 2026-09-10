import fs from "node:fs";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { startScheduler } from "./scheduler.js";
import { bot } from "./telegram/publisher.js";
import { closeDatabase } from "./database/database.js";

fs.mkdirSync(config.storage.downloadDir, { recursive: true });

let scheduler;

async function main() {
  logger.info("𓍢ִ໋🌷 𝐌𝐑𝐒 𝐋𝐎𝐍𝐄𝐑 ⟡ 𝐋𝐈𝐋𝐘 bot starting");

  // The bot does not need polling for publishing, but launching Telegraf
  // keeps the bot connection healthy and allows future commands to be added.
  await bot.launch({
    dropPendingUpdates: true
  });

  scheduler = startScheduler();

  logger.info("Bot is running");
}

function shutdown(signal) {
  logger.info({ signal }, "Graceful shutdown");

  try {
    scheduler?.stop();
  } catch {}

  try {
    bot.stop(signal);
  } catch {}

  try {
    closeDatabase();
  } catch {}

  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", error => {
  logger.error({ error }, "Unhandled rejection");
});

process.on("uncaughtException", error => {
  logger.fatal({ error }, "Uncaught exception");
  // Do not silently continue after an unknown process-level exception.
  process.exit(1);
});

main().catch(error => {
  logger.fatal({ error }, "Startup failed");
  process.exit(1);
});
