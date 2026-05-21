-- Run with: wrangler d1 execute galsaril-db --file=schema.sql

CREATE TABLE IF NOT EXISTS page_views (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  path       TEXT    NOT NULL DEFAULT '/',
  referrer   TEXT,
  country    TEXT,
  city       TEXT,
  device     TEXT,
  browser    TEXT,
  session_id TEXT    NOT NULL,
  ip_hash    TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  props      TEXT,
  session_id TEXT    NOT NULL,
  path       TEXT
);

CREATE TABLE IF NOT EXISTS monitor_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  status_code INTEGER,
  latency_ms  INTEGER,
  ok          INTEGER NOT NULL DEFAULT 1,
  triggered_by TEXT   DEFAULT 'cron'
);

CREATE INDEX IF NOT EXISTS idx_pv_ts         ON page_views(ts);
CREATE INDEX IF NOT EXISTS idx_pv_country    ON page_views(country);
CREATE INDEX IF NOT EXISTS idx_pv_session    ON page_views(session_id);
CREATE INDEX IF NOT EXISTS idx_events_ts     ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_name   ON events(name);
CREATE INDEX IF NOT EXISTS idx_monitor_ts    ON monitor_log(ts);
