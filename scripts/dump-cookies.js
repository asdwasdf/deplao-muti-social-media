/**
 * Wrapper: dump cookie fields từ DB qua Electron (match ABI).
 */
const { spawnSync } = require('child_process');
const path = require('path');

const child = spawnSync(require('electron'), [path.join(__dirname, '_dump-cookies.js')], {
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  timeout: 15000,
});
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
process.exit(child.status ?? 1);