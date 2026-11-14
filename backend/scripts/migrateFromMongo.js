/**
 * One-time copy of an existing MongoDB LearnPool database into Firestore.
 *
 *   cd backend
 *   npm install --no-save mongodb
 *   MONGO_URI="mongodb://127.0.0.1:27017/learnpool" node scripts/migrateFromMongo.js
 *
 * MongoDB is only read. ObjectIds become 24-character strings (same value as before,
 * so every reference keeps pointing at the right document). Re-running overwrites
 * documents with the same id, so it is safe to repeat.
 */
require('dotenv').config();
const { create } = require('../db/firestoreStore');

const COLLECTIONS = ['users', 'courses', 'modules', 'lectures', 'livesessions', 'topics', 'tests', 'results', 'progresses', 'discussions', 'lmsitems'];

function convert(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(convert);
  if (typeof v === 'object') {
    if (v._bsontype === 'ObjectId' || v._bsontype === 'ObjectID') return v.toString();
    if (typeof v.toHexString === 'function') return v.toHexString();
    const out = {};
    for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = convert(val);
    return out;
  }
  return v;
}

function toFirestoreDoc(doc) {
  const { _id, __v, ...rest } = doc;
  return { id: String(_id), data: convert(rest) };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('Set MONGO_URI to the MongoDB database you want to copy from.');
  let MongoClient;
  try { ({ MongoClient } = require('mongodb')); } catch { throw new Error('Run "npm install --no-save mongodb" first (the migration needs the MongoDB driver).'); }
  const store = create();
  await store.ping();
  const client = new MongoClient(uri);
  await client.connect();
  const mongo = client.db();
  try {
    for (const name of COLLECTIONS) {
      const cursor = mongo.collection(name).find({});
      let batch = store.firestore.batch();
      let n = 0, total = 0;
      for await (const doc of cursor) {
        const { id, data } = toFirestoreDoc(doc);
        batch.set(store.firestore.collection(name).doc(id), data);
        n++; total++;
        if (n === 400) { await batch.commit(); batch = store.firestore.batch(); n = 0; }
      }
      if (n) await batch.commit();
      console.log(`${name}: copied ${total} document(s)`);
    }
    console.log('Done. Start the backend and sign in to verify your data.');
  } finally {
    await client.close();
    await store.close();
  }
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { convert, toFirestoreDoc };
