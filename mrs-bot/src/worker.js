import { getCandidates } from "./pinterest/search.js";
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
import {
  hasImageHash,
  recordPost
} from "./database/database.js";
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

  // If diversity made the set too small, fill remaining slots.
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

    if (hasImageHash(hash)) {
      return null;
    }

    return {
      ...candidate,
      category,
      query,
      imageHash: hash,
      filePath: processedPath,
      caption: generateCaption({
        category,
        classification: candidate.classification,
        pin: candidate.pin
      })
    };
  } catch (error) {
    logger.warn({
      error: error.message,
      imageUrl: candidate.imageUrl
    }, "Candidate rejected during download/processing");
    await cleanupFiles(rawPath, processedPath);
    return null;
  }
}

export async function runHourlyJob() {
  const startedAt = Date.now();

  try {
    const { category, query, items } = await getCandidates();

    if (!items.length) {
      logger.warn({ category, query }, "Pinterest returned no candidates");
      return;
    }

    const candidates = filterCandidates(items, category);

    if (!candidates.length) {
      logger.warn({ category, query }, "No candidates passed filters");
      return;
    }

    const selected = selectDiverse(
      candidates,
      config.content.imagesPerPost
    );

    const prepared = [];

    for (const candidate of selected) {
      const item = await prepareCandidate(candidate, category, query);
      if (item) prepared.push(item);

      if (prepared.length >= config.content.imagesPerPost) break;
    }

    if (!prepared.length) {
      logger.warn({ category, query }, "No images survived processing");
      return;
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
        telegramMessageId: messages[i]?.message_id
          ? String(messages[i].message_id)
          : null,
        status: "posted"
      });
    }

    logger.info({
      category,
      query,
      count: prepared.length,
      elapsedMs: Date.now() - startedAt
    }, "Hourly post completed");

    await cleanupFiles(...prepared.flatMap(item => [
      item.filePath,
      item.filePath?.replace("-processed.jpg", ".jpg")
    ]));
  } catch (error) {
    logger.error({
      error: error?.stack || error?.message || String(error),
      elapsedMs: Date.now() - startedAt
    }, "Hourly job failed; scheduler will continue");
  }
}
