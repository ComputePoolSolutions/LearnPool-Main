'use strict';
const { isPlainObject, deepEqual, resolvePath, getPath } = require('./util');
const { ObjectIdType, MixedType, getPathDef } = require('./schema');

const idString = (v) => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && v._id !== undefined && v._id !== null) return String(v._id);
  return String(v);
};

function castFilterValue(def, v) {
  if (!def || v === null || v === undefined) return v;
  const el = def.kind === 'array' ? def.of : def;
  if (el.kind !== 'scalar') return v;
  if (el.type === ObjectIdType) return idString(v);
  if (el.type === String && typeof v === 'string') {
    let s = v;
    if (el.trim) s = s.trim();
    if (el.lowercase) s = s.toLowerCase();
    return s;
  }
  return v;
}

const isOperatorObject = (c) => isPlainObject(c) && Object.keys(c).length > 0 && Object.keys(c).every((k) => k.startsWith('$'));

function castCondition(schema, key, cond) {
  const def = key === '_id' ? { kind: 'scalar', type: ObjectIdType } : getPathDef(schema, key);
  const cv = (v) => castFilterValue(def, v);
  if (isOperatorObject(cond)) {
    const out = {};
    for (const [op, val] of Object.entries(cond)) {
      if (op === '$in' || op === '$nin') out[op] = (Array.isArray(val) ? val : [val]).map(cv);
      else if (['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'].includes(op)) out[op] = cv(val);
      else out[op] = val;
    }
    return out;
  }
  if (cond instanceof RegExp) return cond;
  return Array.isArray(cond) ? cond.map(cv) : cv(cond);
}

function castFilter(schema, filter) {
  const out = {};
  for (const [k, cond] of Object.entries(filter || {})) {
    if (k === '$or' || k === '$and' || k === '$nor') out[k] = cond.map((f) => castFilter(schema, f));
    else out[k] = castCondition(schema, k, cond);
  }
  return out;
}

// ---- matching ------------------------------------------------------------

const norm = (v) => (v instanceof Date ? v.getTime() : v);

function eq(candidate, target) {
  if (target === null || target === undefined) return candidate === null || candidate === undefined;
  if (candidate === null || candidate === undefined) return false;
  if (target instanceof Date || candidate instanceof Date) return norm(candidate) === norm(target);
  if (typeof target === 'object' || typeof candidate === 'object') return deepEqual(candidate, target);
  return candidate === target;
}

function compare(candidate, target, op) {
  const a = norm(candidate);
  const b = norm(target);
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (op === '$gt') return a > b;
  if (op === '$gte') return a >= b;
  if (op === '$lt') return a < b;
  return a <= b;
}

function matchCondition(cands, cond) {
  if (cond instanceof RegExp) return cands.some((c) => typeof c === 'string' && cond.test(c));
  if (isOperatorObject(cond)) {
    for (const [op, val] of Object.entries(cond)) {
      switch (op) {
        case '$eq': if (!cands.some((c) => eq(c, val))) return false; break;
        case '$ne': if (cands.some((c) => eq(c, val))) return false; break;
        case '$in': if (!cands.some((c) => val.some((t) => (t instanceof RegExp ? typeof c === 'string' && t.test(c) : eq(c, t))))) return false; break;
        case '$nin': if (cands.some((c) => val.some((t) => eq(c, t)))) return false; break;
        case '$gt': case '$gte': case '$lt': case '$lte':
          if (!cands.some((c) => compare(c, val, op))) return false; break;
        case '$exists': {
          const exists = cands.some((c) => c !== undefined);
          if (exists !== !!val) return false;
          break;
        }
        case '$regex': {
          const re = val instanceof RegExp ? val : new RegExp(val, cond.$options || '');
          if (!cands.some((c) => typeof c === 'string' && re.test(c))) return false;
          break;
        }
        case '$options': break;
        case '$not': if (matchCondition(cands, val)) return false; break;
        default: throw new Error(`Unsupported query operator ${op}`);
      }
    }
    return true;
  }
  return cands.some((c) => eq(c, cond));
}

function matches(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') { if (!cond.some((f) => matches(doc, f))) return false; continue; }
    if (key === '$and') { if (!cond.every((f) => matches(doc, f))) return false; continue; }
    if (key === '$nor') { if (cond.some((f) => matches(doc, f))) return false; continue; }
    if (!matchCondition(resolvePath(doc, key), cond)) return false;
  }
  return true;
}

// ---- sorting -------------------------------------------------------------

function parseSort(spec) {
  if (!spec) return [];
  if (typeof spec === 'string') {
    return spec.split(/\s+/).filter(Boolean).map((t) => (t.startsWith('-') ? [t.slice(1), -1] : [t.replace(/^\+/, ''), 1]));
  }
  if (Array.isArray(spec)) return spec.map(([k, d]) => [k, d === -1 || d === 'desc' || d === 'descending' ? -1 : 1]);
  return Object.entries(spec).map(([k, d]) => [k, d === -1 || d === 'desc' || d === 'descending' ? -1 : 1]);
}

const rank = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return 1;
  if (typeof v === 'string') return 2;
  if (typeof v === 'boolean') return 3;
  if (v instanceof Date) return 4;
  return 5;
};

function compareValues(a, b) {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  const x = norm(a), y = norm(b);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

function sortRows(rows, sortSpec) {
  if (!sortSpec.length) return rows;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((p, q) => {
      for (const [field, dir] of sortSpec) {
        const c = compareValues(getPath(p.row, field), getPath(q.row, field));
        if (c !== 0) return c * dir;
      }
      return p.i - q.i;
    })
    .map((x) => x.row);
}

// ---- query planning --------------------------------------------------------
// Firestore cannot evaluate arbitrary filters, so we push at most ONE simple
// condition to the database (no composite indexes needed) and evaluate the
// whole filter again in memory.

const isScalar = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const SAFE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function planFilter(schema, filter) {
  let best = null;
  const consider = (cand) => { if (!best || cand.score > best.score) best = cand; };
  for (const [key, cond] of Object.entries(filter)) {
    if (key.startsWith('$')) continue;
    if (isOperatorObject(cond) && Array.isArray(cond.$in) && cond.$in.length === 0) return { empty: true };
    const inList = isOperatorObject(cond) && Array.isArray(cond.$in) && cond.$in.every(isScalar) ? cond.$in : null;
    const eqVal = isScalar(cond) ? cond : (isOperatorObject(cond) && isScalar(cond.$eq) ? cond.$eq : undefined);

    if (key === '_id') {
      if (eqVal !== undefined) consider({ score: 100, kind: 'ids', ids: [String(eqVal)] });
      else if (inList) consider({ score: 99, kind: 'ids', ids: [...new Set(inList.map(String))] });
      continue;
    }
    const def = getPathDef(schema, key);
    if (!def) continue;
    if (key.includes('.')) {
      if (def.dotted && eqVal !== undefined && key.split('.').every((p) => SAFE_SEGMENT.test(p))) {
        consider({ score: 60, kind: 'where', field: key, op: '==', value: eqVal });
      }
      continue;
    }
    if (def.kind === 'array') {
      if (eqVal !== undefined) consider({ score: 40, kind: 'where', field: key, op: 'array-contains', value: eqVal });
    } else if (def.kind === 'scalar' && def.type !== MixedType) {
      const score = def.type === ObjectIdType ? 80 : 50;
      if (eqVal !== undefined) consider({ score, kind: 'where', field: key, op: '==', value: eqVal });
      else if (inList) consider({ score: score - 30, kind: 'where', field: key, op: 'in', value: inList });
    }
  }
  return best;
}

module.exports = { castFilter, castFilterValue, idString, matches, parseSort, sortRows, compareValues, planFilter, isOperatorObject };
