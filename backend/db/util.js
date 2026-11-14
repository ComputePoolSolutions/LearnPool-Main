'use strict';
const crypto = require('crypto');

const isPlainObject = (v) => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

// 24-character hex ids, the same shape MongoDB ObjectIds had, so existing
// validation (`isValidObjectId`) and migrated data keep working.
const newId = () => crypto.randomBytes(12).toString('hex');
const isValidId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

function clone(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) out[k] = clone(v[k]);
    return out;
  }
  return v;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  return false;
}

// Single value at a dotted path (arrays are not traversed).
function getPath(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur && cur[parts[i]];
    if (cur === null || cur === undefined || typeof cur !== 'object') return;
  }
  delete cur[parts[parts.length - 1]];
}

// Every value reachable at a dotted path. Arrays met on the way are walked
// element by element, and an array found at the leaf yields itself plus its
// elements (MongoDB equality semantics).
function resolvePath(obj, path) {
  const parts = path.split('.');
  let level = [obj];
  for (let i = 0; i < parts.length; i++) {
    const next = [];
    for (const item of level) {
      if (item === null || item === undefined) { next.push(undefined); continue; }
      const val = item[parts[i]];
      if (i < parts.length - 1 && Array.isArray(val)) next.push(...val);
      else next.push(val);
    }
    level = next;
  }
  const out = [];
  for (const v of level) {
    out.push(v);
    if (Array.isArray(v)) out.push(...v);
  }
  return out;
}

module.exports = { isPlainObject, newId, isValidId, clone, deepEqual, getPath, setPath, unsetPath, resolvePath };
