/**
 * Test getGroupPosts flow — gọi thẳng www endpoint với cookie từ DB.
 * Args: [groupId, accountIdOrEmpty]
 */
const Database = require('better-sqlite3');
const { safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const groupId = process.argv[2] || '548721893889172';
const accountArg = process.argv[3] || '';

const dbPath = path.join(process.env.APPDATA || '', 'Deplao', 'deplao-tool.db');
if (!fs.existsSync(dbPath)) { console.error('DB not found:', dbPath); process.exit(1); }

const db = new Database(dbPath, { readonly: true });

let account;
try {
  if (accountArg) {
    account = db.prepare(`SELECT id, name, facebook_id, cookie_encrypted FROM fb_accounts WHERE id = ? OR facebook_id = ?`).get(accountArg, accountArg);
  } else {
    account = db.prepare(`SELECT id, name, facebook_id, cookie_encrypted FROM fb_accounts ORDER BY created_at ASC LIMIT 1`).get();
  }
} catch (err) {
  console.error('DB query failed:', err.message);
  process.exit(1);
}
if (!account) { console.error('No FB account in DB'); process.exit(1); }
console.log(`Account: id=${account.id} name=${account.name} facebook_id=${account.facebook_id}`);
console.log(`cookie_encrypted length: ${(account.cookie_encrypted || '').length} chars`);

const cookieEnc = account.cookie_encrypted || '';
let cookie = cookieEnc;
try {
  if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
    const buf = Buffer.from(cookieEnc, 'base64');
    cookie = safeStorage.decryptString(buf);
    console.log(`Decrypted cookie via Electron safeStorage (${cookie.length} bytes)`);
  } else {
    console.log('safeStorage not available, using raw cookie_encrypted');
  }
} catch (err) {
  console.log('safeStorage decrypt failed:', err.message, '— using raw value');
}

console.log(`Cookie preview: ${cookie.slice(0, 120)}...`);

// ─── Test www endpoint với code mới ───
async function testWww() {
  const url = `https://www.facebook.com/groups/${groupId}/?sk=wall`;
  console.log(`\n=== www GET ${url} ===`);
  try {
    const resp = await axios.get(url, {
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
      },
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = String(resp.data || '');
    console.log(`status=${resp.status} htmlLen=${html.length}`);

    const isLogin = /login\.php|checkpoint|name="login"/i.test(html);
    console.log(`isLoginPage=${isLogin}`);

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    console.log(`title: "${titleMatch?.[1] || 'no title'}"`);

    // Apply 6 patterns như code mới
    const seen = new Set();
    const patterns = [
      /\/groups\/\d+\/permalink\/(\d+)/g,
      /\/groups\/\d+\/posts\/(\d+)/g,
      /story_fbid(?:=|%3D)(\d+)/g,
      /fbid(?:=|%3D)(\d+)/g,
      /"post_id"\s*:\s*"?(\d+)"?/g,
      /"id"\s*:\s*"(\d{10,})"/g,
    ];
    for (const re of patterns) {
      const ms = [...html.matchAll(re)].map(m => m[1]);
      ms.forEach(id => { if (id !== groupId) seen.add(id); });
    }
    const pids = [...seen];
    console.log(`post ID candidates: ${pids.length}`);
    console.log(`first 10: ${pids.slice(0, 10).join(', ')}`);

    if (pids.length === 0) {
      // Sample HTML to see what we got
      const sample = html.slice(0, 800).replace(/\s+/g, ' ');
      console.log(`\nHTML sample (first 800 chars):\n${sample}\n`);
    }
    return pids;
  } catch (err) {
    console.log(`ERROR: ${err.message} status=${err.response?.status}`);
    if (err.response?.data) {
      const html = String(err.response.data).slice(0, 400);
      console.log(`error body: ${html}`);
    }
    return [];
  }
}

(async () => {
  const pids = await testWww();
  console.log(`\n=== Summary ===`);
  console.log(`www: ${pids.length} post IDs`);
  if (pids.length === 0) {
    console.log(`\n→ Vấn đề:`);
    console.log(`  Cookie có work với www không? Thử mở browser thường paste URL.`);
    console.log(`  Hoặc account Phương Phạm có bị Facebook flag không?`);
  }
  db.close();
})();