'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(path.dirname(path.resolve(config.dbFile)), { recursive: true });
const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id TEXT NOT NULL,
  contact_id TEXT,
  client_name TEXT NOT NULL,
  agent TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',   -- active | paused | exited | completed
  current_step INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 0,
  exit_reason TEXT,
  recap TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS steps (
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  idx INTEGER NOT NULL,
  portal TEXT NOT NULL,
  status TEXT,                              -- found | none | skip | NULL(pending)
  skip_reason TEXT,
  completed_at TEXT,
  PRIMARY KEY (session_id, idx)
);
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  step_idx INTEGER NOT NULL,
  ref TEXT NOT NULL,
  comment TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  also_for_opportunity TEXT,
  also_for_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS parking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS search_log (
  opportunity_id TEXT PRIMARY KEY,
  last_search_at TEXT,
  rounds INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cross_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id TEXT NOT NULL,          -- the client this property might also fit
  ref TEXT NOT NULL,
  from_session INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consumed INTEGER NOT NULL DEFAULT 0
);
`);

module.exports = db;
