import { config } from "../config.js";
import { hasImageHash, hasPinterestPin } from "../database/database.js";
import { pickImageUrl, pickSourceUrl } from "../pinterest/downloader.js";
import { classifyPin } from "./classifier.js";

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function sourceAllowed(sourceUrl) {
  if (!config.content.requireSourceLink) return true;
  if (!sourceUrl) return false;

  if (!config.content.licensedDomains.length) return true;

  const host = hostnameOf(sourceUrl);
  return Boolean(host && config.content.licensedDomains.some(
    domain => host === domain || host.endsWith(`.${domain}`)
  ));
}

function looksSponsored(pin) {
  return Boolean(
    pin?.is_promoted ||
    pin?.promoted ||
    pin?.ad_data ||
    pin?.is_promoted_pin
  );
}

export function candidateInfo(pin, category) {
  const imageUrl = pickImageUrl(pin);
  const sourceUrl = pickSourceUrl(pin);
  const classification = classifyPin(pin, category);

  return {
    pin,
    imageUrl,
    sourceUrl,
    classification
  };
}

export function filterCandidates(items, category) {
  const accepted = [];

  for (const pin of items) {
    const pinId = pin?.id || pin?.pin_id || pin?.pinId || pin?.pin_url || pin?.url;
    if (!pinId) continue;
    if (hasPinterestPin(String(pinId))) continue;

    if (config.content.skipSponsored && looksSponsored(pin)) {
      continue;
    }

    const candidate = candidateInfo(pin, category);

    if (!candidate.imageUrl) continue;
    if (!sourceAllowed(candidate.sourceUrl)) continue;

    accepted.push(candidate);
  }

  return accepted;
}
