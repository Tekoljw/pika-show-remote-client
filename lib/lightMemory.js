/**
 * 本地"灯光库"存储——跟原来 Python 版 agent.py 的 SQLite 表结构完全对齐
 * （read_light_memory/write_light_memory），因为 agent-server.js 那边的
 * readMemory/writeMemory 请求-回调协议不会变，返回形状必须保持一致：
 *   read  -> { exists, content, error }
 *   write -> { ok, error }
 * content 的字段形状对应 light-sync-ui 的 LibraryPayload（miniappBridge.ts）：
 *   { generatedAt, promptForClaudeCode, venueFixtures, venueReferenceMedia }
 *
 * 这台 PC 本地的数据库是"真实数据源"，服务端那边的 light_library_cache 只是
 * "最后一次成功写入后"的读缓存——PC 离线时云端仍能读到缓存，但 save/scan
 * 必须 PC 在线才能生效。
 *
 * 2026-09-13 起这个 SQLite 文件（`light_memory.db`）也是 showStorage.js
 * 存作品数据用的同一个库——见 reference_show_persistence.md"作品三端保存"，
 * 复用同一个连接（`getDb()` 导出给 showStorage.js require），不单独开新文件。
 */

const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const SLOTS = ["front", "left", "right", "frontWide", "video30s"];

function dbPath() {
  const dir = path.join(require("os").homedir(), ".pika-show-remote");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "light_memory.db");
}

let db = null;
function getDb() {
  if (db) return db;
  db = new DatabaseSync(dbPath());
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS light_library (
      id                      INTEGER PRIMARY KEY CHECK (id = 1),
      generated_at            TEXT,
      prompt_for_claude_code  TEXT,
      venue_fixtures_json     TEXT,
      updated_at              TEXT
    );
    CREATE TABLE IF NOT EXISTS light_reference_media (
      slot       TEXT PRIMARY KEY,
      label      TEXT,
      kind       TEXT,
      file_name  TEXT,
      data       BLOB,
      note       TEXT,
      updated_at TEXT
    );
  `);
  return db;
}

function dataUrlToBytes(dataUrl) {
  if (!dataUrl || !dataUrl.includes(",")) return null;
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

function bytesToDataUrl(buf, kind) {
  if (!buf) return null;
  const mime = kind === "video" ? "video/mp4" : "image/jpeg";
  return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
}

function readLightMemory() {
  try {
    const conn = getDb();
    const row = conn.prepare(
      "SELECT generated_at, prompt_for_claude_code, venue_fixtures_json FROM light_library WHERE id = 1"
    ).get();
    if (!row) return { exists: false, content: null, error: null };

    const media = {};
    for (const m of conn.prepare(
      "SELECT slot, label, kind, file_name, data, note FROM light_reference_media"
    ).all()) {
      media[m.slot] = {
        label: m.label,
        kind: m.kind,
        fileName: m.file_name,
        dataUrl: m.kind === "image" ? bytesToDataUrl(m.data, m.kind) : null,
        note: m.note,
      };
    }
    for (const slot of SLOTS) if (!(slot in media)) media[slot] = null;

    return {
      exists: true,
      content: {
        generatedAt: row.generated_at,
        promptForClaudeCode: row.prompt_for_claude_code,
        venueFixtures: JSON.parse(row.venue_fixtures_json || "[]"),
        venueReferenceMedia: media,
      },
      error: null,
    };
  } catch (e) {
    return { exists: false, content: null, error: e.message };
  }
}

function writeLightMemory(content) {
  try {
    content = content || {};
    const conn = getDb();
    const now = new Date().toISOString();
    conn.prepare(`
      INSERT INTO light_library (id, generated_at, prompt_for_claude_code, venue_fixtures_json, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        generated_at = excluded.generated_at,
        prompt_for_claude_code = excluded.prompt_for_claude_code,
        venue_fixtures_json = excluded.venue_fixtures_json,
        updated_at = excluded.updated_at
    `).run(
      content.generatedAt || null,
      content.promptForClaudeCode || null,
      JSON.stringify(content.venueFixtures || []),
      now
    );

    const media = content.venueReferenceMedia || {};
    for (const slot of SLOTS) {
      const asset = media[slot];
      if (!asset) {
        conn.prepare("DELETE FROM light_reference_media WHERE slot = ?").run(slot);
        continue;
      }
      const raw = asset.kind === "image" ? dataUrlToBytes(asset.dataUrl) : null;
      conn.prepare(`
        INSERT INTO light_reference_media (slot, label, kind, file_name, data, note, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET
          label = excluded.label, kind = excluded.kind, file_name = excluded.file_name,
          data = excluded.data, note = excluded.note, updated_at = excluded.updated_at
      `).run(slot, asset.label || null, asset.kind || null, asset.fileName || null, raw, asset.note || null, now);
    }
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { readLightMemory, writeLightMemory, getDb };
