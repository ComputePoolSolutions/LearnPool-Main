'use strict';
/**
 * Firestore adapter. Everything Firebase-specific lives in this file.
 *
 * Credentials are looked up in this order:
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON  (raw JSON or base64 of the JSON)
 *   2. FIREBASE_SERVICE_ACCOUNT_PATH  (default: backend/serviceAccountKey.json)
 *   3. FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 *   4. Application Default Credentials (Google Cloud) or the Firestore emulator
 *      (set FIRESTORE_EMULATOR_HOST and FIREBASE_PROJECT_ID).
 */
const fs = require('fs');
const path = require('path');

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(text);
  }
  const file = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.join(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    return { project_id: FIREBASE_PROJECT_ID, client_email: FIREBASE_CLIENT_EMAIL, private_key: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') };
  }
  return null;
}

function create() {
  let admin;
  try {
    admin = {
      app: require('firebase-admin/app'),
      fs: require('firebase-admin/firestore'),
    };
  } catch (e) {
    throw new Error('The firebase-admin package is not installed. Run "npm install" in the backend folder.');
  }
  const { initializeApp, cert, applicationDefault, getApps } = admin.app;
  const { getFirestore, FieldValue, Timestamp } = admin.fs;
  const { getAuth } = require('firebase-admin/auth');

  const account = loadServiceAccount();
  const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  let app = getApps()[0];
  if (!app) {
    if (account) app = initializeApp({ credential: cert(account), projectId: account.project_id || process.env.FIREBASE_PROJECT_ID });
    else if (emulator) app = initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'learnpool-local' });
    else app = initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
  }
  const db = getFirestore(app);
  try { db.settings({ ignoreUndefinedProperties: true }); } catch { /* already configured */ }

  // Firestore -> plain JS (Timestamp becomes Date)
  const fromFs = (v) => {
    if (v instanceof Timestamp) return v.toDate();
    if (Array.isArray(v)) return v.map(fromFs);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const o = {};
      for (const k of Object.keys(v)) o[k] = fromFs(v[k]);
      return o;
    }
    return v;
  };
  const toFs = (v) => {
    if (Array.isArray(v)) return v.map(toFs);
    if (v && typeof v === 'object' && !(v instanceof Date) && Object.getPrototypeOf(v) === Object.prototype) {
      const o = {};
      for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = toFs(v[k]);
      return o;
    }
    return v;
  };
  const col = (name) => db.collection(name);
  const row = (snap) => ({ id: snap.id, data: fromFs(snap.data()) });

  return {
    firestore: db,
    FieldValue,
    // Firebase Authentication (used for permanent passwords when FIREBASE_WEB_API_KEY is configured)
    get auth() { return getAuth(app); },

    async ping() {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out connecting to Firestore. Check your Firebase credentials and network.')), 15000));
      await Promise.race([db.collection('_health').doc('ping').get(), timeout]);
    },

    async close() { try { await app.delete(); } catch { /* ignore */ } },

    async getAll(collection, ids) {
      const valid = [...new Set(ids)].filter((id) => SAFE_ID.test(id));
      const out = [];
      for (let i = 0; i < valid.length; i += 100) {
        const refs = valid.slice(i, i + 100).map((id) => col(collection).doc(id));
        const snaps = await db.getAll(...refs);
        for (const s of snaps) if (s.exists) out.push(row(s));
      }
      return out;
    },

    async query(collection, { where, orderBy, limit } = {}) {
      if (where && where.op === 'in') {
        const seen = new Map();
        for (let i = 0; i < where.value.length; i += 30) {
          const snap = await col(collection).where(where.field, 'in', where.value.slice(i, i + 30)).get();
          snap.forEach((d) => seen.set(d.id, row(d)));
        }
        return [...seen.values()];
      }
      let q = col(collection);
      if (where) q = q.where(where.field, where.op, where.value);
      if (orderBy) q = q.orderBy(orderBy.field, orderBy.dir);
      if (limit) q = q.limit(limit);
      const snap = await q.get();
      return snap.docs.map(row);
    },

    async countAll(collection) {
      const res = await col(collection).count().get();
      return res.data().count;
    },

    // Atomic: succeeds for exactly one caller when several try to create the same id at once.
    async createIfAbsent(collection, id, data) {
      try { await col(collection).doc(id).create(toFs(data)); return true; }
      catch (e) { if (e && (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message)))) return false; throw e; }
    },

    async set(collection, id, data) {
      await col(collection).doc(id).set(toFs(data));
    },

    // ops: { set: {path: value}, unset: [path], inc: {path: number} }
    async update(collection, id, ops) {
      const payload = {};
      for (const [k, v] of Object.entries(ops.set || {})) payload[k] = toFs(v);
      for (const k of ops.unset || []) payload[k] = FieldValue.delete();
      for (const [k, n] of Object.entries(ops.inc || {})) payload[k] = FieldValue.increment(n);
      if (!Object.keys(payload).length) return;
      await col(collection).doc(id).update(payload);
    },

    async delete(collection, id) {
      if (!SAFE_ID.test(String(id))) return;
      await col(collection).doc(id).delete();
    },
  };
}

module.exports = { create };
