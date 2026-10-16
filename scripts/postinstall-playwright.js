#!/usr/bin/env node
/**
 * postinstall-playwright.js
 * Tải Chromium binary cho Playwright (dùng cho FB browser login).
 * Chạy riêng để skip được trong môi trường offline.
 *   node scripts/postinstall-playwright.js
 */
'use strict';
const { execSync } = require('child_process');
try {
  console.log('[playwright] Đang tải Chromium (~150MB)...');
  execSync('npx --no-install playwright install chromium', { stdio: 'inherit' });
  console.log('[playwright] ✅ Chromium đã sẵn sàng.');
} catch (err) {
  console.warn('[playwright] ⚠️ Không tải được Chromium:', err.message);
  console.warn('[playwright] Tab "Trình duyệt" trong Add Account sẽ báo lỗi cho tới khi browser được cài.');
  process.exit(0); // Không fail install app, chỉ cảnh báo
}
