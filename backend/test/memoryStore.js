'use strict';
// A tiny in-memory stand-in for the Firestore adapter, so the data layer can be
// tested without a Firebase project. It mimics a few Firestore restrictions on
// purpose (no nested arrays, only plain objects / Dates) to catch mistakes early.
const { clone, getPath, setPath, unsetPath, isPlainObject } = require('../db/util');

function assertStorable(v, where = 'value') {
  if (v === undefined || v === null) return;
  if (v instanceof Date) return;
  if (Array.isArray(v)) {
    for (const x of v) {
      if (Array.isArray(x)) throw new Error(`Firestore does not support nested arrays (${where})`);
      assertStorable(x, where);
    }
    return;
  }
  if (typeof v === 'object') {
    if (!isPlainObject(v)) throw new Error(`Firestore cannot store ${v.constructor && v.constructor.name} instances (${where})`);
    for (const k of Object.keys(v)) assertStorable(v[k], `${where}.${k}`);
    return;
  }
  if (typeof v === 'function' || typeof v === 'symbol') throw new Error(`Cannot store ${typeof v} (${where})`);
}

function create() {
  const data = new Map(); // collection -> Map(id -> doc)
  const coll = (name) => { if (!data.has(name)) data.set(name, new Map()); return data.get(name); };
  const stats = { reads: 0, writes: 0, queries: [] };
  return {
    stats,
    data,
    async ping() {},
    async close() {},
    async getAll(collection, ids) {
      const out = [];
      for (const id of new Set(ids)) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue;
        const d = coll(collection).get(id);
        stats.reads++;
        if (d) out.push({ id, data: clone(d) });
      }
      return out;
    },
    async query(collection, { where, orderBy, limit } = {}) {
      stats.queries.push({ collection, where, orderBy, limit });
      let rows = [...coll(collection).entries()].map(([id, d]) => ({ id, data: clone(d) }));
      stats.reads += rows.length;
      if (where) {
        rows = rows.filter(({ data: d }) => {
          const v = getPath(d, where.field);
          if (where.op === '==') return v === where.value || (v instanceof Date && where.value instanceof Date && v.getTime() === where.value.getTime());
          if (where.op === 'array-contains') return Array.isArray(v) && v.includes(where.value);
          if (where.op === 'in') return where.value.includes(v);
          throw new Error(`memoryStore: unsupported op ${where.op}`);
        });
      }
      if (orderBy) {
        rows = rows.filter(({ data: d }) => getPath(d, orderBy.field) !== undefined);
        rows.sort((a, b) => {
          const x = getPath(a.data, orderBy.field), y = getPath(b.data, orderBy.field);
          const c = x < y ? -1 : x > y ? 1 : 0;
          return orderBy.dir === 'desc' ? -c : c;
        });
      }
      if (limit) rows = rows.slice(0, limit);
      return rows;
    },
    async countAll(collection) { return coll(collection).size; },
    async createIfAbsent(collection, id, doc) {
      if (coll(collection).has(id)) return false;
      coll(collection).set(id, clone(doc));
      return true;
    },
    async set(collection, id, doc) {
      assertStorable(doc, `${collection}/${id}`);
      stats.writes++;
      coll(collection).set(id, clone(doc));
    },
    async update(collection, id, ops) {
      const d = coll(collection).get(id);
      if (!d) throw new Error(`NOT_FOUND: ${collection}/${id}`);
      stats.writes++;
      for (const [k, v] of Object.entries(ops.set || {})) { assertStorable(v, k); setPath(d, k, clone(v)); }
      for (const k of ops.unset || []) unsetPath(d, k);
      for (const [k, n] of Object.entries(ops.inc || {})) setPath(d, k, (Number(getPath(d, k)) || 0) + n);
    },
    async delete(collection, id) { coll(collection).delete(id); },
  };
}

module.exports = { create };
