import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const databasePath =
  process.env.DATABASE_PATH ||
  path.join(process.cwd(), "data", "lily.sqlite");

const databaseDir = path.dirname(databasePath);

if (!fs.existsSync(databaseDir)) {
  fs.mkdirSync(databaseDir, { recursive: true });
}

const db = new Database(databasePath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS posted_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_hash TEXT UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS posted_pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pin_id TEXT UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

export function getState(key, defaultValue = null) {
  const row = db
    .prepare("SELECT value FROM state WHERE key = ?")
    .get(key);

  if (!row) return defaultValue;

  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setState(key, value) {
  const storedValue =
    typeof value === "string" ? value : JSON.stringify(value);

  db.prepare(`
    INSERT INTO state (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, storedValue);
}

export function hasImageHash(imageHash) {
  if (!imageHash) return false;

  return Boolean(
    db
      .prepare("SELECT 1 FROM posted_images WHERE image_hash = ? LIMIT 1")
      .get(imageHash)
  );
}

export function hasPinterestPin(pinId) {
  if (!pinId) return false;

  return Boolean(
    db
      .prepare("SELECT 1 FROM posted_pins WHERE pin_id = ? LIMIT 1")
      .get(pinId)
  );
}

export function recordPost(data = {}) {
  const imageHash = data.imageHash || data.hash || null;
  const pinId = data.pinId || data.id || null;

  if (imageHash) {
    db.prepare(`
      INSERT OR IGNORE INTO posted_images (image_hash)
      VALUES (?)
    `).run(imageHash);
  }

  if (pinId) {
    db.prepare(`
      INSERT OR IGNORE INTO posted_pins (pin_id)
      VALUES (?)
    `).run(String(pinId));
  }
}

export function closeDatabase() {
  db.close();
}

export { db };
export default db;


