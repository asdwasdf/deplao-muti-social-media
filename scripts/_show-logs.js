/**
 * Show last 20 logs from fb_auto_comment_logs.
 */
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(process.env.APPDATA || '', 'Deplao', 'deplao-tool.db');
const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(`
  SELECT id, post_id, group_id, group_name, status, error,
         datetime(executed_at/1000, 'unixepoch') as time,
         comments
  FROM fb_auto_comment_logs
  ORDER BY executed_at DESC
  LIMIT 20
`).all();

console.log(`${rows.length} recent log(s):\n`);
for (const r of rows) {
  let comments = [];
  try { comments = JSON.parse(r.comments || '[]'); } catch {}
  console.log(`[${r.time}] ${r.status.toUpperCase()}`);
  console.log(`  post_id:   ${r.post_id}`);
  console.log(`  group_id:  ${r.group_id}`);
  console.log(`  group:     ${r.group_name}`);
  console.log(`  comments:  ${comments.length} posted`);
  for (const c of comments) {
    console.log(`    - "${c.slice(0, 80)}${c.length > 80 ? '...' : ''}"`);
  }
  if (r.error) console.log(`  error:     ${r.error}`);
  console.log('');
}
db.close();