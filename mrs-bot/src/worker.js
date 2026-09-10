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
        pin: candidate.pin
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
        await new Promise(resolve => setTimeout(resolve, 60000));
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

export async function runHourlyJob() {
  const startedAt = Date.now();

  try {
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

    const selected = selectDiverse(candidates, config.content.imagesPerPost);
    const prepared = [];

    for (const candidate of selected) {
      const item = await prepareCandidate(candidate, category, query);
      if (item) prepared.push(item);
      if (prepared.length >= config.content.imagesPerPost) break;
    }

    if (!prepared.length) {
      logger.warn({ category, query }, "No images survived processing");
      return 0;
    }

    const result = await publish(prepared);
    const messages = Array.isArray(result) ? result : [result];

    for (let i = 0; i < prepared.length; i++) {
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

    await cleanupFiles(...prepared.flatMap(item => [item.filePath, item.rawPath]));

    logger.info({ category, query, count: prepared.length, elapsedMs: Date.now() - startedAt }, "Hourly post completed");
    return prepared.length;
  } catch (error) {
    logger.error({ error: error?.stack || error?.message || String(error), elapsedMs: Date.now() - startedAt }, "Hourly job failed; scheduler will continue");
    return 0;
  }
}

export async function runSearchPostJob(exactQuery, onProgress = null, bulkLimit = 0) {
  const query = String(exactQuery || "").trim();
  if (!query) throw new Error("Search word cannot be empty");

  const startedAt = Date.now();
  logger.info({ query }, "Manual Pinterest search");

  const items = await searchPins(query);
  if (!items.length) return { query, found: 0, posted: 0 };

  // Use a neutral category so the exact user query is preserved in the database.
  const candidates = filterCandidates(items, "manual-search");
  if (!candidates.length) return { query, found: items.length, accepted: 0, posted: 0 };

  // Bulk mode can cap the number of results while preserving the exact search query.
  const limit = Number.isFinite(Number(bulkLimit)) && Number(bulkLimit) > 0 ? Number(bulkLimit) : 0;
  const candidatesToPrepare = limit ? candidates.slice(0, limit) : candidates;

  const prepared = [];
  for (let i = 0; i < candidatesToPrepare.length; i++) {
    const item = await prepareCandidate(candidates[i], "manual-search", query);
    if (item) prepared.push(item);
    if (onProgress) await onProgress({ phase: "preparing", current: i + 1, total: candidatesToPrepare.length });
  }

  const posted = await publishPrepared(prepared, "manual-search", query);

  logger.info({ query, found: items.length, accepted: candidates.length, prepared: prepared.length, posted, elapsedMs: Date.now() - startedAt }, "Manual search post completed");
  return { query, found: items.length, accepted: candidatesToPrepare.length, prepared: prepared.length, posted };
}
