import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";

const databasePath = config.storage.databasePath;

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);

// Keep SQLite reliable on Render and other container hosts.
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS posted_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pinterest_pin_id TEXT NOT NULL,
    image_hash TEXT NOT NULL UNIQUE,
    image_url TEXT,
    source_url TEXT,
    category TEXT,
    query TEXT,
    caption TEXT,
    telegram_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'posted',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_posted_images_created_at
    ON posted_images(created_at);

  CREATE INDEX IF NOT EXISTS idx_posted_images_pin_id
    ON posted_images(pinterest_pin_id);

  CREATE TABLE IF NOT EXISTS scheduled_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    query TEXT NOT NULL,
    amount INTEGER NOT NULL,
    run_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due
    ON scheduled_posts(status, run_at);
`);

const getStateStmt = db.prepare(
  "SELECT value FROM state WHERE key = ?"
);

const setStateStmt = db.prepare(`
  INSERT INTO state (key, value)
  VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

const hasHashStmt = db.prepare(
  "SELECT 1 FROM posted_images WHERE image_hash = ? LIMIT 1"
);

const hasPinStmt = db.prepare(
  "SELECT 1 FROM posted_images WHERE pinterest_pin_id = ? LIMIT 1"
);

const insertPostStmt = db.prepare(`
  INSERT INTO posted_images (
    pinterest_pin_id,
    image_hash,
    image_url,
    source_url,
    category,
    query,
    caption,
    telegram_message_id,
    status
  ) VALUES (
    @pinterestPinId,
    @imageHash,
    @imageUrl,
    @sourceUrl,
    @category,
    @query,
    @caption,
    @telegramMessageId,
    @status
  )
`);

export function getState(key) {
  const row = getStateStmt.get(key);
  return row?.value ?? null;
}

export function setState(key, value) {
  setStateStmt.run(key, value == null ? null : String(value));
}

export function hasImageHash(imageHash) {
  if (!imageHash) return false;
  return Boolean(hasHashStmt.get(imageHash));
}

export function hasPinterestPin(pinterestPinId) {
  if (!pinterestPinId) return false;
  return Boolean(hasPinStmt.get(String(pinterestPinId)));
}

export function recordPost(post) {
  if (!post || typeof post !== "object") {
    throw new TypeError("recordPost requires a post object");
  }

  return insertPostStmt.run({
    pinterestPinId: String(post.pinterestPinId ?? ""),
    imageHash: String(post.imageHash ?? ""),
    imageUrl: post.imageUrl ?? null,
    sourceUrl: post.sourceUrl ?? null,
    category: post.category ?? null,
    query: post.query ?? null,
    caption: post.caption ?? null,
    telegramMessageId:
      post.telegramMessageId == null ? null : String(post.telegramMessageId),
    status: post.status ?? "posted"
  });
}

export function closeDatabase() {
  try {
    db.close();
  } catch {
    // Database may already be closed during shutdown.
  }
}


export function createScheduledPost({ userId, category, query, amount, runAt }) {
  const result = db.prepare(`
    INSERT INTO scheduled_posts (user_id, category, query, amount, run_at, status)
    VALUES (@userId, @category, @query, @amount, @runAt, 'pending')
  `).run({ userId: String(userId), category: String(category), query: String(query), amount: Number(amount), runAt: String(runAt) });
  return Number(result.lastInsertRowid);
}

export function getNextScheduledPost() {
  return db.prepare(`SELECT * FROM scheduled_posts WHERE status = 'pending' ORDER BY run_at ASC, id ASC LIMIT 1`).get() || null;
}

export function getDueScheduledPosts(nowIso = new Date().toISOString()) {
  return db.prepare(`SELECT * FROM scheduled_posts WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC, id ASC`).all(nowIso);
}

export function markScheduledPostRunning(id) {
  return db.prepare(`UPDATE scheduled_posts SET status = 'running' WHERE id = ? AND status = 'pending'`).run(id);
}

export function markScheduledPostDone(id) {
  return db.prepare(`UPDATE scheduled_posts SET status = 'done' WHERE id = ?`).run(id);
}

export function markScheduledPostPending(id) {
  return db.prepare(`UPDATE scheduled_posts SET status = 'pending' WHERE id = ?`).run(id);
}
