import cron from "node-cron";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { runHourlyJob } from "./worker.js";

function cronFromSeconds(seconds) {
  // node-cron is minute-oriented. For the requested hourly default this is exact.
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    if (hours === 1) return "0 * * * *";
    return `0 */${hours} * * *`;
  }

  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `*/${minutes} * * * *`;
  }

  throw new Error(
    "POST_INTERVAL must be a whole number of minutes (3600 is recommended for hourly posting)."
  );
}

export function startScheduler() {
  const expression = cronFromSeconds(config.schedule.intervalSeconds);

  const task = cron.schedule(expression, async () => {
    logger.info("Scheduled content job starting");
    await runHourlyJob();
  });

  logger.info({
    expression,
    intervalSeconds: config.schedule.intervalSeconds
  }, "Scheduler started");

  if (config.schedule.runOnStart) {
    void runHourlyJob();
  }

  return task;
}
