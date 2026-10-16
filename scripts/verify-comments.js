const { spawnSync } = require('child_process');
const path = require('path');
const child = spawnSync(require('electron'), [path.join(__dirname, '_verify-comments.js')], {
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  timeout: 60000,
});
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
process.exit(child.status ?? 1);