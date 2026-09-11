import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import axios from "axios";
import { config } from "../config.js";
import { withRetry } from "../utils/retry.js";

fs.mkdirSync(config.storage.downloadDir, { recursive: true });

function extensionFromContentType(type = "") {
  const clean = type.split(";")[0].toLowerCase();
  if (clean === "image/png") return ".png";
  if (clean === "image/webp") return ".webp";
  if (clean === "image/gif") return ".gif";
  if (clean === "image/jpeg" || clean === "image/jpg") return ".jpg";
  return ".bin";
}

export function pickImageUrl(pin) {
  return (
    pin?.image ||
    pin?.image_url ||
    pin?.imageUrl ||
    pin?.media?.images?.orig?.url ||
    pin?.media?.images?.originals?.url ||
    pin?.media?.images?.["1200x"]?.url ||
    pin?.media?.images?.["736x"]?.url ||
    pin?.media?.images?.["564x"]?.url ||
    pin?.image?.original?.url ||
    pin?.image?.url ||
    null
  );
}

export function pickSourceUrl(pin) {
  return pin?.pin_url || pin?.pinUrl || pin?.link || pin?.url || null;
}

export async function downloadImage(url) {
  return withRetry(async () => {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000,
      maxContentLength: config.content.maxDownloadBytes,
      maxBodyLength: config.content.maxDownloadBytes,
      validateStatus: s => s >= 200 && s < 300
    });

    const contentType = response.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new Error(`URL did not return an image: ${contentType}`);
    }

    const bytes = Buffer.from(response.data);
    if (bytes.length > config.content.maxDownloadBytes) {
      throw new Error("Image exceeds configured download limit");
    }

    const id = crypto.randomUUID();
    const extension = extensionFromContentType(contentType);
    const output = path.join(config.storage.downloadDir, `${id}${extension}`);

    fs.writeFileSync(output, bytes);

    return {
      path: output,
      bytes: bytes.length,
      contentType
    };
  }, {
    retries: Math.min(config.content.maxRetries, 2),
    shouldRetry: error => !error.response || error.response.status >= 500 || error.code === "ECONNABORTED"
  });
}
