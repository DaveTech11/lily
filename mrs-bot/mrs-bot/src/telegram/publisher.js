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
    ...(index === 0 && item.caption ? { caption: item.caption } : {})
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

// ── Buttons ─────────────────────────────────────────────────────

const MAIN_MENU = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "📋 Channel", callback_data: "info_channel" }],
      [{ text: "📅 Schedule", callback_data: "info_schedule" }],
      [{ text: "📊 Stats", callback_data: "info_stats" }],
      [{ text: "📸 Next Post", callback_data: "info_next" }],
      [{ text: "🚀 Post Now", callback_data: "trigger_postnow" }]
    ]
  }
};

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

bot.start((ctx) => {
  ctx.reply(
    `👋 Welcome to MRS LONER ⟡ LILY\n\nI post curated content to ${config.telegram.channelId} every ${config.schedule.intervalSeconds / 60} minutes.\n\nPick an option below:`,
    MAIN_MENU
  );
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
    `🤖 Available commands:\n\n/start — Show menu\n/postnow — Post immediately\n/stats — Bot stats\n/last — Most recent post\n/list — Last 5 posts\n/help — Show commands\n/ping — Health check`,
    MAIN_MENU
  );
});

// ── Middleware ──────────────────────────────────────────────────

bot.catch((err) => {
  logger.error({ error: err?.message || String(err) }, "Telegram bot error");
});
