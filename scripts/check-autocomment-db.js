// Quick script to check auto comment DB state
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(process.env.APPDATA, 'Deplao', 'deplao-tool.db');
console.log('DB path:', dbPath);

const db = new Database(dbPath, { readonly: true });

// Check if tables exist
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fb_auto_comment_%'`).all();
console.log('\nAuto comment tables:', tables);

// Check configs
const configs = db.prepare(`SELECT id, account_id, enabled, schedule_minutes, json_array_length(comments) as comment_count, json_array_length(group_ids) as group_count FROM fb_auto_comment_configs`).all();
console.log('\nConfigs:', configs);

// Check logs count
const logCount = db.prepare(`SELECT COUNT(*) as count FROM fb_auto_comment_logs`).one();
console.log('\nTotal logs:', logCount);

// Check recent logs
const recentLogs = db.prepare(`SELECT id, config_id, group_name, post_id, status, error, executed_at, datetime(executed_at/1000, 'unixepoch') as time FROM fb_auto_comment_logs ORDER BY executed_at DESC LIMIT 10`).all();
console.log('\nRecent logs:', recentLogs);

db.close();
