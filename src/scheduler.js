import cron from "node-cron";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { runHourlyJob, runScheduledPostJob } from "./worker.js";
import { getDueScheduledPosts, markScheduledPostDone, markScheduledPostPending, markScheduledPostRunning } from "./database/database.js";

async function runDueScheduledPosts() {
  const due = getDueScheduledPosts();
  for (const job of due) {
    const claimed = markScheduledPostRunning(job.id);
    if (!claimed.changes) continue;
    try {
      await runScheduledPostJob(job);
      markScheduledPostDone(job.id);
      logger.info({ id: job.id, query: job.query, amount: job.amount }, "Persistent scheduled post completed");
    } catch (error) {
      markScheduledPostPending(job.id);
      logger.warn({ id: job.id, error: error?.message }, "Persistent scheduled post kept pending for retry");
      break;
    }
  }
}

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

  const nextPostTask = cron.schedule("* * * * *", async () => {
    await runDueScheduledPosts();
  });

  // Catch jobs that became due while Render was offline/restarting.
  void runDueScheduledPosts();

  logger.info({
    expression,
    intervalSeconds: config.schedule.intervalSeconds
  }, "Scheduler started");

  if (config.schedule.runOnStart) {
    void runHourlyJob();
  }

  return {
    stop() {
      task.stop();
      nextPostTask.stop();
    }
  };
}
