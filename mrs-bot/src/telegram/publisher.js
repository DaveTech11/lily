import { Telegraf } from "telegraf";
import fs from "node:fs";
import { config } from "../config.js";
import { withRetry } from "../utils/retry.js";
import { logger } from "../utils/logger.js";
import { db, getState, hasImageHash, hasPinterestPin, recordPost, createScheduledPost, getNextScheduledPost } from "../database/database.js";
import { QUERY_GROUPS, randomItem } from "../pinterest/queries.js";
import { searchPins } from "../pinterest/client.js";

export const bot = new Telegraf(config.telegram.token);

// Only these Telegram user IDs may interact with inline buttons.
// Everyone may still use /start and see the menu.
const BUTTON_ACCESS_IDS = new Set([
  "8268158205",
  "7724436551",
  "7680286319"
]);

function canUseButtons(ctx) {
  return BUTTON_ACCESS_IDS.has(String(ctx.from?.id || ""));
}

// Protect every callback button in one place, including future buttons.
bot.use(async (ctx, next) => {
  if (ctx.callbackQuery && !canUseButtons(ctx)) {
    try {
      await ctx.answerCbQuery("⛔ You are not authorized to use these buttons.", { show_alert: true });
    } catch {}
    return;
  }
  return next();
});

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

async function sendAlbum(items, chatId = config.telegram.channelId) {
  const form = new FormData();
  form.append("chat_id", String(chatId));

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
      [primary("🔬 Research", "research")],
      [success("🔎 Search & Post Now", "search_postnow")],
      [success("📦 Bulk Search & Post", "bulk_search_post")],
      [success("🚀 Post Now", "trigger_postnow")],
      [primary("⏸️ Stop Current Task", "stop_task"), primary("▶️ Continue", "continue_task")]
    ]
  }
};

// ── Persistent Next Post scheduling ────────────────────────────
const pendingSchedules = new Map();
const pendingResearches = new Map();
const SCHEDULE_TIMEOUT_MS = 15 * 60 * 1000;

function nextPostCategoryKeyboard() {
  const rows = Object.keys(QUERY_GROUPS).map(category => [
    success(`📂 ${category}`, `next_category:${category}`)
  ]);
  rows.push([primary("✍️ Send Custom", "next_custom")]);
  return { reply_markup: { inline_keyboard: rows } };
}

const NEXT_AMOUNT_MENU = {
  reply_markup: {
    inline_keyboard: [
      [success("1 image", "next_amount:1"), success("5 images", "next_amount:5")],
      [success("10 images", "next_amount:10"), success("25 images", "next_amount:25")],
      [success("50 images", "next_amount:50"), success("100 images", "next_amount:100")],
      [primary("✍️ Custom amount", "next_amount_custom")]
    ]
  }
};

function scheduleTimeToIso(text) {
  const value = String(text || "").trim().replace(/T/, " ");
  const match = value.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (hour > 23 || minute > 59) return null;
  const iso = new Date(`${match[1]}T${String(hour).padStart(2, "0")}:${match[3]}:00+01:00`);
  if (Number.isNaN(iso.getTime())) return null;
  return iso;
}

async function askForScheduleTime(ctx) {
  await ctx.reply(
    "🕐 Send the exact time for this next post in Lagos time (WAT).\n\nFormat: YYYY-MM-DD HH:MM\nExample: 2026-09-12 14:30\n\nThis schedule is saved in the database, so it can still run after the bot reconnects."
  );
}

async function savePendingSchedule(ctx, pending) {
  if (Date.now() - pending.started > SCHEDULE_TIMEOUT_MS) {
    pendingSchedules.delete(ctx.chat.id);
    await ctx.reply("⌛ That scheduling request expired. Press 📸 Next Post and try again.");
    return;
  }

  if (!pending.amount) {
    pending.step = "amount";
    await ctx.reply(`📂 Category: ${pending.category}\n🔎 Search: ${pending.query}\n\n🖼️ How many images should this next post send?`, NEXT_AMOUNT_MENU);
    return;
  }

  if (!pending.runAt) {
    pending.step = "time";
    await askForScheduleTime(ctx);
    return;
  }

  const id = createScheduledPost({
    userId: ctx.from?.id || ctx.chat.id,
    category: pending.category,
    query: pending.query,
    amount: pending.amount,
    runAt: pending.runAt.toISOString()
  });
  pendingSchedules.delete(ctx.chat.id);

  await ctx.reply(
    `✅ Next post scheduled!\n\n📂 Category: ${pending.category}\n🔎 Search: ${pending.query}\n🖼️ Amount: ${pending.amount}\n🕐 Time: ${pending.runAt.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" })} WAT\n🆔 Schedule #${id}\n\nThe bot will post it automatically even if you are offline.`,
    MAIN_MENU
  );
}

bot.action("next_category:wallpapers", async ctx => handleNextCategory(ctx, "wallpapers"));
bot.action("next_category:pfp", async ctx => handleNextCategory(ctx, "pfp"));
bot.action("next_category:lovers", async ctx => handleNextCategory(ctx, "lovers"));
bot.action("next_category:movies", async ctx => handleNextCategory(ctx, "movies"));
bot.action("next_category:moods", async ctx => handleNextCategory(ctx, "moods"));

async function handleNextCategory(ctx, category) {
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat?.type !== "private") return;
  const query = randomItem(QUERY_GROUPS[category] || []);
  pendingSchedules.set(chatId, { step: "amount", category, query, started: Date.now() });
  await ctx.answerCbQuery(`${category} selected`);
  await ctx.reply(`📸 Next Post\n\n📂 Category: ${category}\n🔎 Search: ${query}\n\nChoose the exact amount:`, NEXT_AMOUNT_MENU);
}

bot.action("next_custom", async ctx => {
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat?.type !== "private") return;
  pendingSchedules.set(chatId, { step: "query", category: "custom", started: Date.now() });
  await ctx.answerCbQuery("Send your custom search");
  await ctx.reply("✍️ Send exactly what you want the next post to search on Pinterest.\n\nExample: dark girl aesthetic pfp");
});

for (const amount of [1, 5, 10, 25, 50, 100]) {
  bot.action(`next_amount:${amount}`, async ctx => {
    const chatId = ctx.chat?.id;
    const pending = pendingSchedules.get(chatId);
    if (!pending) return ctx.answerCbQuery("Start Next Post first", { show_alert: true });
    pending.amount = amount;
    pending.step = "time";
    await ctx.answerCbQuery(`${amount} images selected`);
    await askForScheduleTime(ctx);
  });
}

bot.action("next_amount_custom", async ctx => {
  const chatId = ctx.chat?.id;
  const pending = pendingSchedules.get(chatId);
  if (!pending) return ctx.answerCbQuery("Start Next Post first", { show_alert: true });
  pending.step = "amount_custom";
  await ctx.answerCbQuery("Send the amount");
  await ctx.reply("🖼️ Send the exact number of images to post.\n\nMaximum: 100");
});

bot.action("info_next", async ctx => {
  const next = getNextScheduledPost();
  if (!next) {
    await ctx.editMessageText("📸 Next Post\n\nNo custom next post is scheduled yet.\n\nChoose a category or send your own search, then set the amount and exact time.", nextPostCategoryKeyboard());
    return;
  }
  const when = new Date(next.run_at).toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
  await ctx.editMessageText(`📸 Next Post\n\n📂 Category: ${next.category}\n🔎 Search: ${next.query}\n🖼️ Amount: ${next.amount}\n🕐 Time: ${when} WAT\n\nThis schedule is stored persistently and will run after a restart/offline period.`, nextPostCategoryKeyboard());
});

// ── Research ───────────────────────────────────────────────────
bot.action("research", async ctx => {
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat?.type !== "private") return;
  pendingResearches.set(chatId, Date.now());
  await ctx.answerCbQuery("Send a topic to research");
  await ctx.reply("🔬 Research\n\nSend a topic or Pinterest search phrase. I will research the current Pinterest results and tell you how many usable images are available.\n\nExample: dark aesthetic pfp");
});

// ── Search & Post Now ───────────────────────────────────────────
// Stores one pending search per private chat. The next text message becomes
// the exact Pinterest search query; no random query is substituted.
const pendingSearches = new Map();
const SEARCH_TIMEOUT_MS = 5 * 60 * 1000;
const pendingBulkSearches = new Map();

// Search results are posted directly after the user selects the amount.

// Handle the search phrase after the button prompt.
bot.on("text", async (ctx, next) => {
  if (ctx.chat?.type !== "private") return next();

  const chatId = ctx.chat.id;

  const scheduled = pendingSchedules.get(chatId);
  if (scheduled) {
    if (Date.now() - scheduled.started > SCHEDULE_TIMEOUT_MS) {
      pendingSchedules.delete(chatId);
      await ctx.reply("⌛ That scheduling request expired. Press 📸 Next Post and try again.");
      return;
    }

    const text = String(ctx.message.text || "").trim();
    if (scheduled.step === "query") {
      if (!text || text.startsWith("/")) return ctx.reply("❌ Send a normal search phrase, for example: soft girl pfp");
      scheduled.query = text;
      scheduled.step = "amount";
      scheduled.category = "custom";
      await ctx.reply(`✍️ Custom search: ${text}\n\n🖼️ Choose the exact amount:`, NEXT_AMOUNT_MENU);
      return;
    }
    if (scheduled.step === "amount_custom") {
      const amount = Number(text);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100) return ctx.reply("❌ Amount must be a whole number from 1 to 100.");
      scheduled.amount = amount;
      scheduled.step = "time";
      await askForScheduleTime(ctx);
      return;
    }
    if (scheduled.step === "time") {
      const runAt = scheduleTimeToIso(text);
      if (!runAt || runAt.getTime() <= Date.now()) return ctx.reply("❌ Invalid or past time. Use YYYY-MM-DD HH:MM in Lagos time, for example 2026-09-12 14:30.");
      scheduled.runAt = runAt;
      await savePendingSchedule(ctx, scheduled);
      return;
    }
  }

  const researchStarted = pendingResearches.get(chatId);
  if (researchStarted) {
    pendingResearches.delete(chatId);
    if (Date.now() - researchStarted > SEARCH_TIMEOUT_MS) return ctx.reply("⌛ Research request expired. Press 🔬 Research and try again.");
    const topic = String(ctx.message.text || "").trim();
    if (!topic || topic.startsWith("/")) return ctx.reply("❌ Send a research topic or Pinterest search phrase.");
    try {
      await ctx.reply(`🔬 Researching Pinterest for: ${topic}\n\n⏳ Checking current results...`);
      const results = await searchPins(topic);
      const usable = results.filter(item => item?.imageUrl || item?.image_url || item?.image || item?.url);
      await ctx.reply(`🔬 Research complete\n\n🔎 Query: ${topic}\n📌 Results found: ${results.length}\n🖼️ Images with usable image data: ${usable.length}\n\nIf you like this topic, use 🔎 Search & Post Now or 📸 Next Post to schedule it.`, MAIN_MENU);
    } catch (error) {
      await ctx.reply(`❌ Research failed: ${error?.message?.slice(0, 300) || "Unknown error"}`);
    }
    return;
  }

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


bot.command("nextpost", async ctx => {
  if (ctx.chat?.type !== "private") return;
  await ctx.reply("📸 Next Post\n\nChoose what you want to post:", nextPostCategoryKeyboard());
});

bot.command("research", async ctx => {
  if (ctx.chat?.type !== "private") return;
  pendingResearches.set(ctx.chat.id, Date.now());
  await ctx.reply("🔬 Send a topic or Pinterest search phrase to research.");
});

// Catch-all for unknown commands
bot.command("help", (ctx) => {
  ctx.reply(
    `🤖 Available commands:\n\n/start — Show menu\n/postnow — Post immediately\n/search — Search Pinterest and post results
📦 Bulk Search & Post — Search and bulk-post 10/25/50/100/all results\n/stats — Bot stats\n/last — Most recent post\n/list — Last 5 posts\n/help — Show commands\n/stop — Pause current task\n/continue — Resume paused task\n/task — Current task status\n/menu — Show image menu\n/ping — Health check\n/nextpost — Schedule the next post\n/research — Research Pinterest`,
    MAIN_MENU
  );
});

// ── Middleware ──────────────────────────────────────────────────

bot.catch((err) => {
  logger.error({ error: err?.message || String(err) }, "Telegram bot error");
});
