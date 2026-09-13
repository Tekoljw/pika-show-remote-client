/**
 * 本地"作品"存储——"三端保存"其中一端（本地/云端/灯控台），见项目记忆
 * reference_show_persistence.md。复用 lightMemory.js 打开的同一个 SQLite
 * 连接（同一个文件 `~/.pika-show-remote/light_memory.db`），不单独开新库。
 *
 * `shows`/`show_groups` 两张表对应"本地"Tab——可编辑草稿，云端/前端上传下载
 * 都是覆盖这两张表。`console_shows` 对应"灯控台"Tab——发送到 QLC+ 成功后的
 * 存档，见 engine.js 的 `_handleSendShow`，这个模块只提供读取，写入是发送
 * 流程的副作用，不单独暴露写接口。
 *
 * 字段形状对应 light-sync-ui 的 Show/ShowGroup 类型（src/types.ts），JSON
 * 字段（waveform/events）原样转成字符串存，不拆列——这些是纯展示/回放用的
 * 数据，不需要按字段查询，拆列没有实际收益。
 */

const { getDb } = require("./lightMemory");

function ensureTables() {
  const conn = getDb();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS shows (
      id            TEXT PRIMARY KEY,
      file_name     TEXT,
      display_name  TEXT,
      group_id      TEXT,
      locked        INTEGER NOT NULL DEFAULT 0,
      music_name    TEXT,
      duration      REAL,
      waveform_json TEXT,
      events_json   TEXT,
      updated_at    TEXT
    );
    CREATE TABLE IF NOT EXISTS show_groups (
      id   TEXT PRIMARY KEY,
      name TEXT
    );
    CREATE TABLE IF NOT EXISTS console_shows (
      id                TEXT PRIMARY KEY,
      file_name         TEXT,
      display_name      TEXT,
      group_id          TEXT,
      locked            INTEGER NOT NULL DEFAULT 0,
      music_name        TEXT,
      duration          REAL,
      waveform_json     TEXT,
      events_json       TEXT,
      qlc_xml           TEXT,
      chase_function_id INTEGER,
      sent_at           TEXT
    );
  `);
  return conn;
}

function rowToShow(row) {
  return {
    id: row.id,
    fileName: row.file_name,
    displayName: row.display_name,
    groupId: row.group_id,
    locked: !!row.locked,
    musicName: row.music_name,
    duration: row.duration || 0,
    waveform: JSON.parse(row.waveform_json || "[]"),
    events: JSON.parse(row.events_json || "[]"),
    updatedAt: row.updated_at,
  };
}

/** "本地"Tab 用——读全部草稿 + 分组 */
function listShows() {
  try {
    const conn = ensureTables();
    const shows = conn.prepare("SELECT * FROM shows ORDER BY updated_at DESC").all().map(rowToShow);
    const groups = conn.prepare("SELECT id, name FROM show_groups").all();
    return { ok: true, shows, groups };
  } catch (e) {
    return { ok: false, error: e.message, shows: [], groups: [] };
  }
}

/** 新建/更新一条本地作品——同 id 覆盖，跟云端 upsertVenueShow 是同一个语义。 */
function writeShow(show) {
  try {
    const conn = ensureTables();
    const now = new Date().toISOString();
    conn.prepare(`
      INSERT INTO shows (id, file_name, display_name, group_id, locked, music_name, duration, waveform_json, events_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        file_name = excluded.file_name, display_name = excluded.display_name, group_id = excluded.group_id,
        locked = excluded.locked, music_name = excluded.music_name, duration = excluded.duration,
        waveform_json = excluded.waveform_json, events_json = excluded.events_json, updated_at = excluded.updated_at
    `).run(
      show.id, show.fileName || null, show.displayName, show.groupId || null,
      show.locked ? 1 : 0, show.musicName || null, show.duration || 0,
      JSON.stringify(show.waveform || []), JSON.stringify(show.events || []), now
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function deleteShow(showId) {
  try {
    const conn = ensureTables();
    conn.prepare("DELETE FROM shows WHERE id = ?").run(showId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 分组改动少，整体替换——跟云端 saveVenueShowGroups 同一个语义。 */
function writeShowGroups(groups) {
  const conn = ensureTables();
  try {
    conn.exec("BEGIN");
    conn.prepare("DELETE FROM show_groups").run();
    for (const g of groups || []) {
      conn.prepare("INSERT INTO show_groups (id, name) VALUES (?, ?)").run(g.id, g.name);
    }
    conn.exec("COMMIT");
    return { ok: true };
  } catch (e) {
    try { conn.exec("ROLLBACK"); } catch {}
    return { ok: false, error: e.message };
  }
}

/**
 * "灯控台"Tab 用——只读，列出已经真实发送过、还留着存档的作品。这些记录
 * 只能通过 _handleSendShow 成功发送时产生，这里不提供写入。
 */
function listConsoleShows() {
  try {
    const conn = ensureTables();
    const shows = conn.prepare("SELECT * FROM console_shows ORDER BY sent_at DESC").all().map((row) => ({
      ...rowToShow(row),
      chaseFunctionId: row.chase_function_id,
      sentAt: row.sent_at,
    }));
    return { ok: true, shows };
  } catch (e) {
    return { ok: false, error: e.message, shows: [] };
  }
}

/**
 * 发送到灯控台成功后调用——存一份独立存档，按 show id 覆盖（同一作品重发
 * 覆盖旧存档，不同作品互不影响），见 engine.js 的 _handleSendShow。这才是
 * "真正的存档"：GENERATED_WORKSPACE_PATH 那份是"当前可执行工作区"，随便一个
 * 新作品发送就会被覆盖；这张表按作品 id 独立保存，不会被别的作品冲掉。
 */
function archiveConsoleShow(show, qlcXml, chaseFunctionId) {
  try {
    const conn = ensureTables();
    const now = new Date().toISOString();
    conn.prepare(`
      INSERT INTO console_shows (id, file_name, display_name, group_id, locked, music_name, duration, waveform_json, events_json, qlc_xml, chase_function_id, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        file_name = excluded.file_name, display_name = excluded.display_name, group_id = excluded.group_id,
        locked = excluded.locked, music_name = excluded.music_name, duration = excluded.duration,
        waveform_json = excluded.waveform_json, events_json = excluded.events_json,
        qlc_xml = excluded.qlc_xml, chase_function_id = excluded.chase_function_id, sent_at = excluded.sent_at
    `).run(
      show.id, show.fileName || null, show.displayName, show.groupId || null,
      show.locked ? 1 : 0, show.musicName || null, show.duration || 0,
      JSON.stringify(show.waveform || []), JSON.stringify(show.events || []),
      qlcXml || null, chaseFunctionId ?? null, now
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { listShows, writeShow, deleteShow, writeShowGroups, listConsoleShows, archiveConsoleShow };
