import { getCandidates } from "./pinterest/search.js";
import { searchPins } from "./pinterest/client.js";
import { filterCandidates } from "./images/filter.js";
import { downloadImage } from "./pinterest/downloader.js";
import {
  inspectImage,
  processImage,
  sha256,
  cleanupFiles
} from "./images/processor.js";
import { generateCaption } from "./captions/generator.js";
import { publish } from "./telegram/publisher.js";
import { config } from "./config.js";
import { hasImageHash, recordPost } from "./database/database.js";
import { logger } from "./utils/logger.js";


// ── Global task controls ───────────────────────────────────────
let activeTask = null;

function beginTask(type, query = null) {
  if (activeTask) throw new Error(`A ${activeTask.type} task is already running.`);
  activeTask = { type, query, paused: false, startedAt: Date.now() };
}

function finishTask() {
  activeTask = null;
}

async function waitIfPaused() {
  while (activeTask?.paused) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function pauseAwareDelay(ms) {
  let remaining = ms;
  while (remaining > 0) {
    await waitIfPaused();
    const slice = Math.min(1000, remaining);
    await new Promise(resolve => setTimeout(resolve, slice));
    remaining -= slice;
  }
}

export function stopCurrentTask() {
  if (!activeTask) return false;
  activeTask.paused = true;
  logger.info({ type: activeTask.type, query: activeTask.query }, "Current task paused");
  return true;
}

export function continueCurrentTask() {
  if (!activeTask) return false;
  activeTask.paused = false;
  logger.info({ type: activeTask.type, query: activeTask.query }, "Current task continued");
  return true;
}

export function getCurrentTask() {
  return activeTask ? { ...activeTask } : null;
}

function selectDiverse(candidates, count) {
  const sorted = [...candidates].sort(() => Math.random() - 0.5);
  const selected = [];
  const seenStyles = new Set();

  for (const candidate of sorted) {
    const style = candidate.classification?.label || "other";
    if (seenStyles.has(style) && selected.length < count) continue;
    selected.push(candidate);
    seenStyles.add(style);
    if (selected.length >= count) break;
  }

  for (const candidate of sorted) {
    if (selected.includes(candidate)) continue;
    selected.push(candidate);
    if (selected.length >= count) break;
  }

  return selected;
}

async function prepareCandidate(candidate, category, query) {
  let rawPath;
  let processedPath;

  try {
    const downloaded = await downloadImage(candidate.imageUrl);
    rawPath = downloaded.path;
    await inspectImage(rawPath);
    processedPath = await processImage(rawPath);
    const hash = await sha256(processedPath);

    if (hasImageHash(hash)) return null;

    return {
      ...candidate,
      category,
      query,
      imageHash: hash,
      filePath: processedPath,
      rawPath,
      caption: generateCaption({
        category,
        classification: candidate.classification,
        pin: candidate.pin,
        query
      })
    };
  } catch (error) {
    logger.warn({ error: error.message, imageUrl: candidate.imageUrl }, "Candidate rejected during download/processing");
    await cleanupFiles(rawPath, processedPath);
    return null;
  }
}

async function publishPrepared(prepared, category, query) {
  let posted = 0;

  // Telegram supports up to 10 photos in one media group. Send search
  // results as albums instead of one message per image.
  const BATCH_SIZE = 10;

  for (let start = 0; start < prepared.length; start += BATCH_SIZE) {
    await waitIfPaused();
    const batch = prepared.slice(start, start + BATCH_SIZE);

    try {
      const results = await publish(batch);
      const telegramResults = Array.isArray(results)
        ? results
        : (results ? [results] : []);

      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const telegramMessage = telegramResults[i];
        const messageId = telegramMessage?.message_id
          ? String(telegramMessage.message_id)
          : null;

        recordPost({
          pinterestPinId: String(
            item.pin?.id ||
            item.pin?.pin_id ||
            item.pin?.pinId ||
            item.pin?.pin_url ||
            item.pin?.url ||
            `manual-${item.imageHash}`
          ),
          imageHash: item.imageHash,
          imageUrl: item.imageUrl,
          sourceUrl: item.sourceUrl,
          category,
          query,
          caption: item.caption,
          telegramMessageId: messageId,
          status: "posted"
        });

        posted++;
      }

      for (const item of batch) {
        await cleanupFiles(item.filePath, item.rawPath);
      }

      logger.info(
        { query, batchSize: batch.length, posted, total: prepared.length },
        "Manual search album posted"
      );

      // Pause 1 minute between albums. Images inside an album arrive together.
      if (start + BATCH_SIZE < prepared.length) {
        await pauseAwareDelay(60000);
      }
    } catch (error) {
      logger.warn(
        { error: error?.message, query, batchSize: batch.length },
        "Manual search album failed; continuing"
      );

      for (const item of batch) {
        await cleanupFiles(item.filePath, item.rawPath);
      }
    }
  }

  return posted;
}

export async function runScheduledPostJob({ category, query, amount }) {
  const count = Math.min(Math.max(Number(amount) || 1, 1), 100);
  const startedAt = Date.now();
  beginTask("scheduled-next-post", query);

  try {
    const items = await searchPins(query);
    if (!items.length) return { query, found: 0, posted: 0 };

    const candidates = filterCandidates(items, category || "scheduled");
    const selected = candidates.slice(0, count);
    const prepared = [];

    for (const candidate of selected) {
      await waitIfPaused();
      const item = await prepareCandidate(candidate, category || "scheduled", query);
      if (item) prepared.push(item);
      if (prepared.length >= count) break;
    }

    const posted = await publishPrepared(prepared, category || "scheduled", query);
    logger.info({ category, query, requested: count, found: items.length, posted, elapsedMs: Date.now() - startedAt }, "Scheduled next post completed");
    return { query, found: items.length, posted, requested: count };
  } finally {
    finishTask();
  }
}

export async function runHourlyJob() {
  const startedAt = Date.now();

  try {
    beginTask("scheduled-post");
    await waitIfPaused();
    const { category, query, items } = await getCandidates();

    if (!items.length) {
      logger.warn({ category, query }, "Pinterest returned no candidates");
      return 0;
    }

    const candidates = filterCandidates(items, category);
    if (!candidates.length) {
      logger.warn({ category, query }, "No candidates passed filters");
      return 0;
    }

    const hourlyCount = 10;
    const selected = selectDiverse(candidates, hourlyCount);
    const prepared = [];

    for (const candidate of selected) {
      await waitIfPaused();
      const item = await prepareCandidate(candidate, category, query);
      if (item) prepared.push(item);
      if (prepared.length >= hourlyCount) break;
    }

    if (!prepared.length) {
      logger.warn({ category, query }, "No images survived processing");
      return 0;
    }

    await waitIfPaused();
    const result = await publish(prepared.slice(0, 10));
    const messages = Array.isArray(result) ? result : [result];

    for (let i = 0; i < Math.min(prepared.length, 10); i++) {
      recordPost({
        pinterestPinId: String(prepared[i].pin.id),
        imageHash: prepared[i].imageHash,
        imageUrl: prepared[i].imageUrl,
        sourceUrl: prepared[i].sourceUrl,
        category,
        query,
        caption: prepared[i].caption,
        telegramMessageId: messages[i]?.message_id ? String(messages[i].message_id) : null,
        status: "posted"
      });
    }

    await cleanupFiles(...prepared.slice(0, 10).flatMap(item => [item.filePath, item.rawPath]));
    logger.info({ category, query, count: prepared.length, elapsedMs: Date.now() - startedAt }, "Hourly post completed");
    return prepared.length;
  } catch (error) {
    logger.error({ error: error?.stack || error?.message || String(error), elapsedMs: Date.now() - startedAt }, "Hourly job failed; scheduler will continue");
    return 0;
  } finally {
    finishTask();
  }
}

export async function runSearchPostJob(exactQuery, onProgress = null, bulkLimit = 0, onConfirm = null) {
  const query = String(exactQuery || "").trim();
  if (!query) throw new Error("Search word cannot be empty");

  const startedAt = Date.now();
  beginTask("search-post", query);

  try {
    logger.info({ query }, "Manual Pinterest search");
    await waitIfPaused();

    const items = await searchPins(query);
    if (!items.length) return { query, found: 0, posted: 0 };

    const candidates = filterCandidates(items, "manual-search");
    if (!candidates.length) return { query, found: items.length, accepted: 0, posted: 0 };

    const limit = Number.isFinite(Number(bulkLimit)) && Number(bulkLimit) > 0 ? Number(bulkLimit) : 0;
    const candidatesToPrepare = limit ? candidates.slice(0, limit) : candidates;

    const prepared = [];
    for (let i = 0; i < candidatesToPrepare.length; i++) {
      await waitIfPaused();
      const item = await prepareCandidate(candidatesToPrepare[i], "manual-search", query);
      if (item) prepared.push(item);
      if (onProgress) await onProgress({ phase: "preparing", current: i + 1, total: candidatesToPrepare.length });
    }

    await waitIfPaused();

    // When a confirmation callback is supplied, each prepared image is sent
    // to the requesting user's DM. Tapping Send posts it immediately; Leave
    // discards it. Scheduled jobs do not use this path.
    if (typeof onConfirm === "function") {
      let posted = 0;
      let left = 0;

      for (const item of prepared) {
        await waitIfPaused();
        const approved = await onConfirm(item);
        if (approved) posted++;
        else left++;
      }

      logger.info({ query, found: items.length, accepted: candidatesToPrepare.length, prepared: prepared.length, posted, left, elapsedMs: Date.now() - startedAt }, "Manual search confirmation flow completed");
      return { query, found: items.length, accepted: candidatesToPrepare.length, prepared: prepared.length, posted, left };
    }

    const posted = await publishPrepared(prepared, "manual-search", query);

    logger.info({ query, found: items.length, accepted: candidatesToPrepare.length, prepared: prepared.length, posted, elapsedMs: Date.now() - startedAt }, "Manual search post completed");
    return { query, found: items.length, accepted: candidatesToPrepare.length, prepared: prepared.length, posted };
  } finally {
    finishTask();
  }
}
