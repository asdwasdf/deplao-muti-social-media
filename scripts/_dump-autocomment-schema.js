/**
 * Runs inside Electron (ELECTRON_RUN_AS_NODE) so the better-sqlite3 native
 * module matches the compiled ABI. Dumps the two auto-comment tables.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const candidates = [
  path.join(process.env.APPDATA || '', 'Deplao', 'deplao-tool.db'),
  path.join(process.env.APPDATA || '', 'Deplao', 'workspaces', 'default', 'deplao-tool.db'),
];

function findDb() {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const dbPath = findDb();
if (!dbPath) {
  console.error('No DB found. Tried:\n' + candidates.join('\n'));
  process.exit(1);
}

console.log('DB:', dbPath);
const db = new Database(dbPath, { readonly: true });

for (const table of ['fb_auto_comment_configs', 'fb_auto_comment_logs']) {
  console.log(`\n=== ${table} ===`);
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.length === 0) {
    console.log('  (table does not exist)');
    continue;
  }
  for (const c of cols) {
    console.log(`  ${c.cid}\t${c.name}\t${c.type}\tnotnull=${c.notnull}\tdefault=${c.dflt_value ?? ''}`);
  }
  const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  console.log(`  rows: ${count.n}`);
}

db.close();
