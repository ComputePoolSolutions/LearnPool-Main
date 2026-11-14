/**
 * Writes a full JSON backup of every LearnPool collection to backend/backups/.
 * Run it before any data change:  npm run backup
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { create } = require('../db/firestoreStore');

const COLLECTIONS = ['users', 'courses', 'modules', 'lectures', 'livesessions', 'topics', 'tests', 'results', 'progresses', 'discussions', 'lmsitems'];

// Dates are written as {"__date": "..."} so a restore can rebuild them exactly.
const encode = v => {
  if (v instanceof Date) return { __date: v.toISOString() };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
};

async function main() {
  const store = create();
  await store.ping();
  const out = { createdAt: new Date().toISOString(), collections: {} };
  for (const name of COLLECTIONS) {
    const rows = await store.query(name, {});
    out.collections[name] = rows.map(r => ({ id: r.id, data: encode(r.data) }));
    console.log(`${name}: ${rows.length} document(s)`);
  }
  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `learnpool-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(`Backup saved to ${file}`);
  await store.close();
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { encode };
