/**
 * Runs inside Electron (ELECTRON_RUN_AS_NODE) so the better-sqlite3 native
 * module matches the compiled ABI. Migrates the two auto-comment tables from
 * the old schema (shopee_links/fixed_comment + comment_1/comment_2) to the
 * new schema (single comments JSON column).
 *
 * Idempotent: safe to run multiple times. Handles 0-row and populated DBs.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(process.env.APPDATA || '', 'Deplao', 'deplao-tool.db');
if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(1);
}

const db = new Database(dbPath);

function tableInfo(name) {
  return db.prepare(`PRAGMA table_info(${name})`).all();
}

function countRows(name) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n;
}

function migrateConfigs() {
  const cols = tableInfo('fb_auto_comment_configs');
  if (cols.length === 0) return 'configs: missing (app will create)';

  const hasNew = cols.some((c) => c.name === 'comments');
  const hasOld = cols.some((c) => c.name === 'shopee_links');

  if (hasNew) return 'configs: already migrated';
  if (!hasOld) return 'configs: unknown schema — manual review needed';

  const rowCount = countRows('fb_auto_comment_configs');

  db.exec(`DROP INDEX IF EXISTS idx_fb_auto_comment_account`);
  db.exec(`ALTER TABLE fb_auto_comment_configs RENAME TO fb_auto_comment_configs_old`);
  db.exec(`
    CREATE TABLE fb_auto_comment_configs (
      id                  TEXT PRIMARY KEY,
      workspace_id        TEXT DEFAULT '',
      account_id          TEXT NOT NULL,
      comments            TEXT DEFAULT '[]',
      group_ids           TEXT DEFAULT '[]',
      max_posts_per_run   INTEGER DEFAULT 10,
      schedule_minutes    INTEGER DEFAULT 60,
      enabled             INTEGER DEFAULT 1,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE INDEX idx_fb_auto_comment_account ON fb_auto_comment_configs(account_id);
  `);

  if (rowCount > 0) {
    const oldRows = db.prepare(`SELECT * FROM fb_auto_comment_configs_old`).all();
    const insert = db.prepare(`
      INSERT INTO fb_auto_comment_configs
        (id, workspace_id, account_id, comments, group_ids,
         max_posts_per_run, schedule_minutes, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const run = db.transaction((rows) => {
      for (const row of rows) {
        let shopeeLinks = [];
        try { shopeeLinks = JSON.parse(row.shopee_links || '[]'); } catch {}
        const fixed = row.fixed_comment || '';
        const comments = fixed ? [fixed, ...shopeeLinks] : shopeeLinks;

        insert.run(
          row.id,
          row.workspace_id || '',
          row.account_id,
          JSON.stringify(comments),
          row.group_ids || '[]',
          row.max_comments_per_run || 10,
          row.schedule_minutes || 60,
          row.enabled ?? 1,
          row.created_at,
          row.updated_at,
        );
      }
    });
    run(oldRows);
  }

  db.exec(`DROP TABLE fb_auto_comment_configs_old`);
  return `configs: migrated (${rowCount} rows preserved)`;
}

function migrateLogs() {
  const cols = tableInfo('fb_auto_comment_logs');
  if (cols.length === 0) return 'logs: missing (app will create)';

  const hasNew = cols.some((c) => c.name === 'comments');
  const hasOld = cols.some((c) => c.name === 'comment_1');

  if (hasNew) return 'logs: already migrated';
  if (!hasOld) return 'logs: unknown schema — manual review needed';

  const rowCount = countRows('fb_auto_comment_logs');

  db.exec(`DROP INDEX IF EXISTS idx_fb_auto_comment_logs_config`);
  db.exec(`ALTER TABLE fb_auto_comment_logs RENAME TO fb_auto_comment_logs_old`);
  db.exec(`
    CREATE TABLE fb_auto_comment_logs (
      id           TEXT PRIMARY KEY,
      config_id    TEXT NOT NULL,
      group_id     TEXT NOT NULL,
      group_name   TEXT DEFAULT '',
      post_id      TEXT NOT NULL,
      comments     TEXT DEFAULT '[]',
      status       TEXT DEFAULT 'success',
      error        TEXT DEFAULT '',
      executed_at  INTEGER NOT NULL,
      FOREIGN KEY (config_id) REFERENCES fb_auto_comment_configs(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_fb_auto_comment_logs_config ON fb_auto_comment_logs(config_id);
  `);

  if (rowCount > 0) {
    const oldRows = db.prepare(`SELECT * FROM fb_auto_comment_logs_old`).all();
    const insert = db.prepare(`
      INSERT INTO fb_auto_comment_logs
        (id, config_id, group_id, group_name, post_id, comments, status, error, executed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const run = db.transaction((rows) => {
      for (const row of rows) {
        const comments = [row.comment_1, row.comment_2].filter((c) => c);
        insert.run(
          row.id,
          row.config_id,
          row.group_id,
          row.group_name || '',
          row.post_id,
          JSON.stringify(comments),
          row.status || 'success',
          row.error || '',
          row.executed_at,
        );
      }
    });
    run(oldRows);
  }

  db.exec(`DROP TABLE fb_auto_comment_logs_old`);
  return `logs: migrated (${rowCount} rows preserved)`;
}

console.log('DB:', dbPath);
console.log(migrateConfigs());
console.log(migrateLogs());
db.close();