/**
 * Dump cookie fields từ DB để so sánh với browser.
 */
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(process.env.APPDATA || '', 'Deplao', 'deplao-tool.db');
const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(`SELECT id, name, facebook_id, LENGTH(cookie_encrypted) as enc_len, cookie_encrypted FROM fb_accounts ORDER BY created_at ASC`).all();
for (const r of rows) {
  console.log(`\n=== ${r.name} (id=${r.id}, fb_id=${r.facebook_id}) ===`);
  console.log(`encrypted length: ${r.enc_len}`);
  // Parse as cookie string (may or may not be encrypted)
  const cookie = r.cookie_encrypted || '';
  const fields = cookie.split(/;\s*/).filter(Boolean).map(c => {
    const eq = c.indexOf('=');
    return eq > 0 ? c.slice(0, eq) : c;
  });
  console.log(`fields (${fields.length}): ${fields.join(', ')}`);
  console.log(`raw preview: ${cookie.slice(0, 200)}`);
}
db.close();