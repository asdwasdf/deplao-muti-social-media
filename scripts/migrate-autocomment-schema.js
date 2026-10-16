/**
 * Wrapper: spawns Electron with ELECTRON_RUN_AS_NODE so better-sqlite3 loads
 * against the compiled ABI (NODE_MODULE_VERSION 145). The inner script does
 * the actual schema migration.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const electronPath = require('electron');
const projectRoot = path.resolve(__dirname, '..');
const entry = path.join(projectRoot, 'scripts', '_migrate-autocomment-schema.js');

const child = spawnSync(electronPath, [entry], {
  cwd: projectRoot,
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  timeout: 30000,
});

if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
process.exit(child.status ?? 1);