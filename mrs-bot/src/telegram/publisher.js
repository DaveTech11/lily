import { Telegraf } from "telegraf";
import fs from "node:fs";
import { config } from "../config.js";
import { withRetry } from "../utils/retry.js";
import { logger } from "../utils/logger.js";
import { db, getState, hasImageHash, hasPinterestPin } from "../database/database.js";

export const bot = new Telegraf(config.telegram.token);

// ── Telegram upload helpers ─────────────────────────────────────
const TELEGRAM_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS || 60000);

function telegramApiUrl(method) {
  return `https://api.telegram.org/bot${config.telegram.token}/${method}`;
}

async function telegramRequest(method, form) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    const response = await fetch(telegramApiUrl(method), {
      method: "POST",
      body: form,
      signal: controller.signal
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: false, description: text }; }

    if (!response.ok || !data.ok) {
      const error = new Error(data.description || `Telegram API HTTP ${response.status}`);
      error.response = { statusCode: response.status, error_code: data.error_code };
      throw error;
    }

    return data.result;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`Telegram ${method} timed out after ${TELEGRAM_TIMEOUT_MS}ms`);
      timeoutError.code = "ETIMEDOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fileBlob(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  return new Blob([buffer], { type: "image/jpeg" });
}

async function sendSingle(item) {
  const form = new FormData();
  form.append("chat_id", String(config.telegram.channelId));
  form.append("photo", await fileBlob(item.filePath), "image.jpg");
  if (item.caption) form.append("caption", item.caption);
  form.append("disable_notification", "true");
  return telegramRequest("sendPhoto", form);
}

async function sendAlbum(items) {
  const form = new FormData();
  form.append("chat_id", String(config.telegram.channelId));

  const media = items.map((item, index) => ({
    type: "photo",
    media: `attach://photo${index}`,
    ...(item.caption ? { caption: item.caption } : {})
  }));

  form.append("media", JSON.stringify(media));

  for (let i = 0; i < items.length; i++) {
    form.append(`photo${i}`, await fileBlob(items[i].filePath), `image-${i}.jpg`);
  }

  return telegramRequest("sendMediaGroup", form);
}


// ── Public publish API ──────────────────────────────────────────

export async function publish(items) {
  if (!items.length) throw new Error("No items to publish");

  return withRetry(
    async () => {
      if (items.length === 1) return await sendSingle(items[0]);
      return await sendAlbum(items);
    },
    {
      retries: config.content.maxRetries,
      shouldRetry: error => {
        const status = error?.response?.error_code;
        return !status || status === 429 || status >= 500 || ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE"].includes(error?.code);
      },
      onRetry: async (error, attempt, delay) => {
        logger.warn({ attempt, delay, error: error?.message }, "Telegram upload retrying");
      }
    }
  );
}

// ── Buttons / image menu ───────────────────────────────────────
const MENU_IMAGE_URL = "https://i.ibb.co/G46CgB0F/photo-2026-09-10-14-12-20.jpg";

const primary = (text, callback_data) => ({ text, callback_data, style: "primary" });
const success = (text, callback_data) => ({ text, callback_data, style: "success" });

const MAIN_MENU = {
  reply_markup: {
    inline_keyboard: [
      [primary("📋 Channel", "info_channel")],
      [primary("📅 Schedule", "info_schedule")],
      [primary("📊 Stats", "info_stats")],
      [primary("📸 Next Post", "info_next")],
      [success("🔎 Search & Post Now", "search_postnow")],
      [success("📦 Bulk Search & Post", "bulk_search_post")],
      [success("🚀 Post Now", "trigger_postnow")],
      [primary("⏸️ Stop Current Task", "stop_task"), primary("▶️ Continue", "continue_task")]
    ]
  }
};

// ── Search & Post Now ───────────────────────────────────────────
// Stores one pending search per private chat. The next text message becomes
// the exact Pinterest search query; no random query is substituted.
const pendingSearches = new Map();
const SEARCH_TIMEOUT_MS = 5 * 60 * 1000;
const pendingBulkSearches = new Map();

async function askForSearch(ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat?.type !== "private") return;

  pendingSearches.set(chatId, Date.now());
  await ctx.reply(
    "🔎 Send the exact search word or phrase you want me to search on Pinterest.\n\nExample: pink wallpapers\n\nI will use exactly what you send and post every valid result I can retrieve, with captions.",
    { reply_markup: { force_reply: true, selective: true } }
  );
}

bot.action("search_postnow", async (ctx) => {
  await ctx.answerCbQuery("Send your search word");
  await askForSearch(ctx);
});

async function askForBulkSearch(ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat?.type !== "private") return;

  pendingBulkSearches.set(chatId, { step: "query", started: Date.now() });
  await ctx.reply(
    "📦 Bulk Search & Post\n\nSend the exact Pinterest search word or phrase. I will search exactly what you send, then ask how many results you want posted.\n\nExample: anime wallpaper",
    { reply_markup: { force_reply: true, selective: true } }
  );
}

bot.action("bulk_search_post", async (ctx) => {
  await ctx.answerCbQuery("Send your search word");
  await askForBulkSearch(ctx);
});

const BULK_QTY_MENU = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "10 images", callback_data: "bulk_qty_10", style: "success" }, { text: "25 images", callback_data: "bulk_qty_25", style: "success" }],
      [{ text: "50 images", callback_data: "bulk_qty_50", style: "success" }, { text: "100 images", callback_data: "bulk_qty_100", style: "success" }],
      [{ text: "♾️ All available", callback_data: "bulk_qty_all", style: "success" }]
    ]
  }
};

for (const [key, qty] of [["bulk_qty_10",10],["bulk_qty_25",25],["bulk_qty_50",50],["bulk_qty_100",100],["bulk_qty_all",0]]) {
  bot.action(key, async (ctx) => {
    const chatId = ctx.chat?.id;
    const bulk = pendingBulkSearches.get(chatId);
    const normal = pendingSearches.get(chatId);
    const pending = bulk?.step === "quantity" ? bulk : (normal?.step === "quantity" ? normal : null);
    const isBulk = !!(bulk?.step === "quantity");

    if (!pending) {
      await ctx.answerCbQuery("Start a search first");
      return;
    }

    if (isBulk) pendingBulkSearches.delete(chatId);
    else pendingSearches.delete(chatId);

    if (Date.now() - pending.started > SEARCH_TIMEOUT_MS) {
      await ctx.answerCbQuery("Request expired");
      await ctx.reply("⌛ That search request expired. Start the search again and try again.");
      return;
    }

    await ctx.answerCbQuery(qty ? `Posting ${qty} images` : "Posting all available");
    await ctx.reply(`${isBulk ? "📦 Bulk search started" : "🔎 Search started"}

🔎 Exact query: ${pending.query}
🖼️ Amount: ${qty || "all available"}
⏳ Searching Pinterest and preparing your selected images...`);

    try {
      const { runSearchPostJob } = await import("../worker.js");
      const result = await runSearchPostJob(pending.query, null, qty);
      await ctx.reply(`✅ ${isBulk ? "Bulk post" : "Search post"} complete!

🔎 Query: ${result.query}
📌 Results found: ${result.found}
🖼️ Posted: ${result.posted}
⏭️ Skipped/failed: ${Math.max(0, (result.accepted || 0) - result.posted)}
📢 Channel: ${config.telegram.channelId}`);
    } catch (error) {
      logger.error({ error: error?.stack || error?.message, query: pending.query, qty }, `${isBulk ? "Bulk Search & Post" : "Search & Post"} failed`);
      await ctx.reply(`❌ ${isBulk ? "Bulk Search & Post" : "Search & Post"} failed: ${error?.message?.slice(0, 300) || "Unknown error"}`);
    }
  });
}


// Handle the search phrase after the button prompt.
bot.on("text", async (ctx, next) => {
  if (ctx.chat?.type !== "private") return next();

  const chatId = ctx.chat.id;
  const bulk = pendingBulkSearches.get(chatId);

  // IMPORTANT: Bulk mode must be checked before normal search mode.
  // Otherwise a bulk query is silently passed to the next middleware.
  if (bulk?.step === "query") {
    pendingBulkSearches.delete(chatId);

    if (Date.now() - bulk.started > SEARCH_TIMEOUT_MS) {
      await ctx.reply("⌛ That bulk search request expired. Press 📦 Bulk Search & Post and try again.");
      return;
    }

    const query = String(ctx.message.text || "").trim();

    if (!query || query.startsWith("/")) {
      await ctx.reply("❌ Please send a search word or phrase, for example: boy aesthetic pfp dark");
      return;
    }

    pendingBulkSearches.set(chatId, {
      step: "quantity",
      query,
      started: bulk.started
    });

    await ctx.reply(
      `🔎 Exact search: ${query}\n\nHow many results should I bulk-post?`,
      BULK_QTY_MENU
    );
    return;
  }

  const started = pendingSearches.get(chatId);
  if (!started) return next();

  // Normal Search & Post now also asks for the number of images before posting.
  pendingSearches.delete(chatId);

  if (Date.now() - (typeof started === "object" ? started.started : started) > SEARCH_TIMEOUT_MS) {
    await ctx.reply("⌛ That search request expired. Press 🔎 Search & Post Now and try again.");
    return;
  }

  const query = String(ctx.message.text || "").trim();

  if (!query || query.startsWith("/")) {
    await ctx.reply("❌ Please send a search word or phrase, for example: pink wallpapers");
    return;
  }

  pendingSearches.set(chatId, {
    step: "quantity",
    query,
    started: typeof started === "object" ? started.started : started
  });

  await ctx.reply(
    `🔎 Searching Pinterest for exactly: ${query}\n\n🖼️ How many images do you want me to send?`,
    BULK_QTY_MENU
  );
  return;
});

// ── Task controls ──────────────────────────────────────────────

async function sendImageMenu(ctx) {
  const caption = `🌷 MRS LONER ⟡ LILY\n\nChoose what you want to do:`;
  return ctx.replyWithPhoto(MENU_IMAGE_URL, { caption, ...MAIN_MENU });
}

bot.command("menu", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  try {
    await sendImageMenu(ctx);
  } catch (error) {
    logger.warn({ error: error?.message }, "Menu image failed; sending text menu");
    await ctx.reply("🌷 MRS LONER ⟡ LILY\n\nChoose what you want to do:", MAIN_MENU);
  }
});

bot.action("stop_task", async (ctx) => {
  const { stopCurrentTask } = await import("../worker.js");
  const stopped = stopCurrentTask();
  await ctx.answerCbQuery(stopped ? "Task paused" : "No active task");
  await ctx.reply(stopped ? "⏸️ Current task paused. Use /continue to resume it." : "ℹ️ There is no active task right now.");
});

bot.action("continue_task", async (ctx) => {
  const { continueCurrentTask } = await import("../worker.js");
  const continued = continueCurrentTask();
  await ctx.answerCbQuery(continued ? "Task continued" : "No paused task");
  await ctx.reply(continued ? "▶️ Current task continued." : "ℹ️ There is no paused task right now.");
});

bot.command("stop", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  const { stopCurrentTask } = await import("../worker.js");
  const stopped = stopCurrentTask();
  await ctx.reply(stopped ? "⏸️ Current task paused. Use /continue to resume." : "ℹ️ There is no active task right now.");
});

bot.command("continue", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  const { continueCurrentTask } = await import("../worker.js");
  const continued = continueCurrentTask();
  await ctx.reply(continued ? "▶️ Current task continued." : "ℹ️ There is no paused task right now.");
});

bot.command("task", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  const { getCurrentTask } = await import("../worker.js");
  const task = getCurrentTask();
  if (!task) return ctx.reply("ℹ️ No task is currently running.");
  await ctx.reply(`📌 Current task: ${task.type}\n🔎 Query: ${task.query || "—"}\n${task.paused ? "⏸️ Status: paused" : "▶️ Status: running"}`);
});

// ── Post Now ────────────────────────────────────────────────────

bot.command("postnow", async (ctx) => {
  if (ctx.chat?.type !== "private") {
    return ctx.reply("Use /postnow in private chat with the bot.");
  }
  await ctx.reply("⏳ Posting now — fetching Pinterest → processing → sending to channel…");
  try {
    const { runHourlyJob } = await import("../worker.js");
    await runHourlyJob();
    await ctx.reply("✅ Done — check @safespaceoriginal. If nothing posted, see /stats and logs.");
  } catch (e) {
    logger.error({ error: e?.message }, "postnow failed");
    await ctx.reply(`❌ Failed: ${e.message?.slice(0,300)}`);
  }
});

bot.action("trigger_postnow", async (ctx) => {
  await ctx.answerCbQuery("Posting…");
  await ctx.reply("⏳ Posting now…");
  try {
    const { runHourlyJob } = await import("../worker.js");
    await runHourlyJob();
    await ctx.reply("✅ Done — check channel");
  } catch (e) {
    await ctx.reply(`❌ Failed: ${e.message?.slice(0,300)}`);
  }
});

// ── Helpers ─────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

// ── Command handlers ────────────────────────────────────────────

bot.start(async (ctx) => {
  try {
    await ctx.replyWithPhoto(MENU_IMAGE_URL, {
      caption: `👋 Welcome to MRS LONER ⟡ LILY\n\nI post curated content to ${config.telegram.channelId} every ${config.schedule.intervalSeconds / 60} minutes.\n\nPick an option below:`,
      ...MAIN_MENU
    });
  } catch (error) {
    logger.warn({ error: error?.message }, "Start menu image failed; using text menu");
    await ctx.reply(
      `👋 Welcome to MRS LONER ⟡ LILY\n\nPick an option below:`,
      MAIN_MENU
    );
  }
});

bot.command("ping", (ctx) => {
  if (ctx.chat?.type !== "private") return;
  ctx.reply("🏓 pong");
});

// Stats — total posts, last post, next scheduled
bot.command("stats", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  try {
    const total = db.prepare("SELECT COUNT(*) AS c FROM posted_images").get().c;
    const last = db.prepare("SELECT created_at, category, caption FROM posted_images ORDER BY id DESC LIMIT 1").get();
    const next = getState("last_category") ? `Scheduled (interval: ${config.schedule.intervalSeconds / 60} min)` : "Waiting";

    ctx.reply(
      `📊 Bot Stats\n` +
      `──────────────\n` +
      `Total posts: ${total}\n` +
      `Last post:   ${last ? fmtDate(last.created_at) + ` · ${last.category}` : "—"}\n` +
      `Next post:   ${next}\n` +
      `Channel:     ${config.telegram.channelId}`,
      MAIN_MENU
    );
  } catch (err) {
    ctx.reply("⚠️ Could not fetch stats.");
    logger.error({ error: err?.message }, "stats command error");
  }
});

// Last post — show the most recent post details
bot.command("last", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  try {
    const row = db.prepare(
      "SELECT pinterest_pin_id, category, query, caption, created_at, image_url FROM posted_images ORDER BY id DESC LIMIT 1"
    ).get();

    if (!row) {
      ctx.reply("📭 No posts yet.");
      return;
    }

    const text =
      `🖼️ Last Post\n` +
      `───────────\n` +
      `Category:  ${row.category}\n` +
      `Query:     ${row.query}\n` +
      `Pin ID:    ${row.pinterest_pin_id}\n` +
      `Caption:   ${row.caption || "—"}\n` +
      `Posted:    ${fmtDate(row.created_at)}`;

    ctx.reply(text);
  } catch (err) {
    ctx.reply("⚠️ Could not fetch last post.");
    logger.error({ error: err?.message }, "last command error");
  }
});

// List recent posts (last 5)
bot.command("list", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  try {
    const rows = db.prepare(
      "SELECT category, query, caption, created_at FROM posted_images ORDER BY id DESC LIMIT 5"
    ).all();

    if (!rows.length) {
      ctx.reply("📭 No posts yet.");
      return;
    }

    const lines = rows.map((r, i) =>
      `${i + 1}. ${fmtDate(r.created_at)} · ${r.category} · ${r.query}`
    );

    ctx.reply(`📋 Recent Posts\n──────────────\n${lines.join("\n")}`, MAIN_MENU);
  } catch (err) {
    ctx.reply("⚠️ Could not fetch post list.");
    logger.error({ error: err?.message }, "list command error");
  }
});

// Button / callback handlers
bot.action("info_channel", async (ctx) => {
  await ctx.editMessageText(
    `📋 Channel: ${config.telegram.channelId}\n\nAll posts go here automatically.`,
    { parse_mode: "Markdown" }
  );
});

bot.action("info_schedule", async (ctx) => {
  await ctx.editMessageText(
    `📅 Posting interval: every ${config.schedule.intervalSeconds / 60} minutes\n\nNext post is scheduled automatically.`,
    { parse_mode: "Markdown" }
  );
});

bot.action("info_stats", async (ctx) => {
  try {
    const total = db.prepare("SELECT COUNT(*) AS c FROM posted_images").get().c;
    await ctx.editMessageText(
      `📊 Stats\n───\nTotal posts: ${total}\nChannel: ${config.telegram.channelId}\nInterval: ${config.schedule.intervalSeconds / 60} min`,
      { parse_mode: "Markdown" }
    );
  } catch {
    await ctx.editMessageText("⚠️ Could not fetch stats.");
  }
});

bot.action("info_next", async (ctx) => {
  await ctx.editMessageText(
    `📸 Next post is being prepared.\n\nCheck back in a few minutes!`,
    { parse_mode: "Markdown" }
  );
});

// Catch-all for unknown commands
bot.command("help", (ctx) => {
  ctx.reply(
    `🤖 Available commands:\n\n/start — Show menu\n/postnow — Post immediately\n/search — Search Pinterest and post results
📦 Bulk Search & Post — Search and bulk-post 10/25/50/100/all results\n/stats — Bot stats\n/last — Most recent post\n/list — Last 5 posts\n/help — Show commands\n/stop — Pause current task\n/continue — Resume paused task\n/task — Current task status\n/menu — Show image menu\n/ping — Health check`,
    MAIN_MENU
  );
});

// ── Middleware ──────────────────────────────────────────────────

bot.catch((err) => {
  logger.error({ error: err?.message || String(err) }, "Telegram bot error");
});
