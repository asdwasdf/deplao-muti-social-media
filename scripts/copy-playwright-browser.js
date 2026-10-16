#!/usr/bin/env node
/**
 * copy-playwright-browser.js
 * Copy Playwright Chromium binary từ cache mặc định (%LOCALAPPDATA%/ms-playwright/)
 * vào ./playwright-browsers/ để electron-builder đóng gói qua extraResources.
 *
 * Chạy sau khi `playwright install chromium` xong.
 *   node scripts/copy-playwright-browser.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'playwright-browsers');

// Cache mặc định của Playwright
function findCacheRoot() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH)) {
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
    process.env.HOME && path.join(process.env.HOME, 'Library', 'Caches', 'ms-playwright'),
    process.env.HOME && path.join(process.env.HOME, '.cache', 'ms-playwright'),
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
    // symlinks: skip (Playwright dùng symlink cho .local-browsers)
  }
}

const cache = findCacheRoot();
if (!cache) {
  console.warn('[copy-playwright] Không tìm thấy Playwright cache. Chạy `npm run install:playwright` trước.');
  process.exit(0);
}

const chromiumDirs = fs.readdirSync(cache, { withFileTypes: true })
  .filter(e => e.isDirectory() && /^chromium-/.test(e.name))
  .map(e => ({ name: e.name, full: path.join(cache, e.name) }))
  .sort((a, b) => {
    // Sắp theo version descending (vd chromium-1217 < chromium-1248)
    const va = parseInt(a.name.split('-')[1] || '0', 10);
    const vb = parseInt(b.name.split('-')[1] || '0', 10);
    return vb - va;
  });
const chromiumDir = chromiumDirs[0]?.full;

if (!chromiumDir) {
  console.warn('[copy-playwright] Không có chromium-* trong cache.');
  process.exit(0);
}

console.log(`[copy-playwright] Source: ${chromiumDir}`);
console.log(`[copy-playwright] Target: ${TARGET}`);

// Dọn target cũ
if (fs.existsSync(TARGET)) fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(TARGET, { recursive: true });
copyDir(chromiumDir, TARGET);
console.log('[copy-playwright] ✅ Done. Browser đã sẵn sàng để electron-builder đóng gói.');