/**
 * Dump fb_auto_comment_configs + fb_auto_comment_logs schema.
 * Avoids better-sqlite3 ABI mismatch by spawning Electron, which loads the
 * native module with the matching NODE_MODULE_VERSION.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const electron = require('electron');
const electronPath = electron;

const projectRoot = path.resolve(__dirname, '..');
const entryPath = path.join(projectRoot, 'scripts', '_dump-autocomment-schema.js');

const child = spawnSync(electronPath, [entryPath], {
  cwd: projectRoot,
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  timeout: 30000,
});

if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
process.exit(child.status ?? 1);
