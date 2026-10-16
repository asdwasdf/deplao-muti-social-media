/**
 * Verify comments thật trên FB: query post bằng post_id, lấy comments,
 * so sánh với DB log xem có match.
 */
const Database = require('better-sqlite3');
const { safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const dbPath = path.join(process.env.APPDATA || '', 'Deplao', 'deplao-tool.db');
const db = new Database(dbPath, { readonly: true });

// Lấy 1 log mới nhất
const recent = db.prepare(`
  SELECT post_id, comments, group_id, group_name, status, error,
         datetime(executed_at/1000, 'unixepoch') as time
  FROM fb_auto_comment_logs ORDER BY executed_at DESC LIMIT 1
`).get();
db.close();

if (!recent) { console.log('No logs'); process.exit(1); }

let comments = [];
try { comments = JSON.parse(recent.comments || '[]'); } catch {}
console.log(`DB log:`);
console.log(`  post_id: ${recent.post_id}`);
console.log(`  group_id: ${recent.group_id}`);
console.log(`  group: ${recent.group_name}`);
console.log(`  time: ${recent.time}`);
console.log(`  status: ${recent.status}`);
console.log(`  comments in log: ${comments.length}`);
for (const c of comments) {
  console.log(`    - "${c.slice(0, 100)}"`);
}

// Lấy account + cookie
const db2 = new Database(dbPath, { readonly: true });
const acc = db2.prepare(`SELECT cookie_encrypted, facebook_id FROM fb_accounts ORDER BY created_at ASC LIMIT 1`).get();
db2.close();

let cookie = acc.cookie_encrypted;
try {
  if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
    cookie = safeStorage.decryptString(Buffer.from(acc.cookie_encrypted, 'base64'));
  }
} catch {}

// Query FB mbasic comment page cho post
const postId = recent.post_id;
const groupId = recent.group_id;

// Cách 1: mbasic comment permalink
const url = `https://mbasic.facebook.com/groups/${groupId}/permalink/${postId}/`;
console.log(`\nFetching ${url}...`);

(async () => {
  try {
    const resp = await axios.get(url, {
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      timeout: 30000,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = String(resp.data || '');
    console.log(`status=${resp.status} htmlLen=${html.length}`);

    // Check xem có comment nào hiển thị không
    const isLogin = /login\.php|name="login"/i.test(html);
    console.log(`isLoginPage=${isLogin}`);

    // Đếm comment bằng từ khóa
    const commentCount = (html.match(/<h3 class="be[^"]*">/g) || []).length;
    console.log(`<h3 class="be..."> matches: ${commentCount} (FB render comment author name)`);

    // Check xem text comment có trong HTML không
    for (const c of comments) {
      const cPreview = c.slice(0, 30);
      const found = html.includes(cPreview);
      console.log(`  "${cPreview}..." found in HTML: ${found}`);
    }

    // Extract comment texts
    const commentTexts = [...html.matchAll(/<div class="[^"]*"[^>]*>([^<]{20,300})<\/div>/g)]
      .map(m => m[1].trim())
      .filter(t => !t.startsWith('http'));
    console.log(`\nExtracted text snippets (${commentTexts.length}):`);
    for (const t of commentTexts.slice(0, 10)) {
      console.log(`  - "${t.slice(0, 80)}"`);
    }

  } catch (err) {
    console.log(`ERROR: ${err.message} status=${err.response?.status}`);
  }
})();