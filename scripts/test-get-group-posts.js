/**
 * Test getGroupPosts flow trực tiếp (không qua Electron).
 * Đọc cookie từ DB, gọi mbasic + www endpoint, parse HTML.
 * Verify xem có lấy được post ID từ group thật không.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const electronPath = require('electron');
const projectRoot = path.resolve(__dirname, '..');
const entry = path.join(projectRoot, 'scripts', '_test-get-group-posts.js');

const groupId = process.argv[2] || '548721893889172';
const accountId = process.argv[3] || '';

const child = spawnSync(electronPath, [entry, groupId, accountId], {
  cwd: projectRoot,
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  timeout: 60000,
});

if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
process.exit(child.status ?? 1);