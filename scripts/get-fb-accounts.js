const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'deplao-tool.db');
const db = new Database(dbPath, { readonly: true });

const accounts = db.prepare(`
  SELECT id, name, channelType
  FROM accounts
  WHERE channelType = 'facebook'
  LIMIT 10
`).all();

console.log(JSON.stringify(accounts, null, 2));
db.close();
