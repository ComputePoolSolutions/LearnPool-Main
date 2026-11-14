'use strict';
/**
 * LearnPool data layer for Firebase Firestore.
 *
 * It exposes a small Mongoose-compatible API (Schema, model, find / findOne /
 * findById / create / save / populate / select / sort / limit / lean ...) on top
 * of Firestore, so routes and models keep working with very few changes.
 *
 * Firestore has no joins and limited query operators, so:
 *   - at most one simple condition of a filter is sent to Firestore,
 *   - the complete filter is re-checked in memory (see ./match.js),
 *   - populate() fetches referenced documents by id and stitches them in.
 */
const { Schema, ObjectIdType, MixedType, ValidationError, buildObject, castKeys, castPath, withDefaults, getDefault, getPathDef } = require('./schema');
const { castFilter, matches, parseSort, sortRows, planFilter, isOperatorObject } = require('./match');
const { isPlainObject, newId, isValidId, clone, deepEqual, getPath, setPath, unsetPath, resolvePath } = require('./util');

// ---- connection / store ----------------------------------------------------

let store = null;
const connection = { readyState: 0 };

async function connect() {
  if (!store) store = require('./firestoreStore').create();
  await store.ping();
  connection.readyState = 1;
  return module.exports;
}
async function disconnect() {
  connection.readyState = 0;
  if (store && store.close) await store.close();
  store = null;
}
// Lets tests (or a different backend) plug in another store implementation.
function useStore(s) { store = s; connection.readyState = 1; }
function getStore() {
  if (!store) throw new Error('Database is not connected. Call db.connect() first.');
  return store;
}

// A short-lived lock (atomic create of a marker document). Returns a release function, or null if
// somebody else currently holds it. Locks expire on their own, so a crash can never block forever.
async function acquireLock(name, ttlMs = 30000) {
  const s = getStore();
  const id = require('crypto').createHash('sha256').update(String(name)).digest('hex').slice(0, 40);
  const make = () => s.createIfAbsent('_locks', id, { name: String(name).slice(0, 120), expiresAt: new Date(Date.now() + ttlMs) });
  const release = () => s.delete('_locks', id).catch(() => {});
  if (await make()) return release;
  const [row] = await s.getAll('_locks', [id]);
  if (row && row.data.expiresAt && new Date(row.data.expiresAt).getTime() < Date.now()) {
    await s.delete('_locks', id);
    if (await make()) return release;
  }
  return null;
}

// ---- registry --------------------------------------------------------------

const models = {};
const pluralize = (name) => { const n = name.toLowerCase(); return n.endsWith('s') ? `${n}es` : `${n}s`; };

// ---- Document --------------------------------------------------------------

class Document {
  constructor(model, raw, { isNew = false } = {}) {
    Object.defineProperty(this, '__model', { value: model, writable: true, enumerable: false });
    Object.defineProperty(this, '__isNew', { value: isNew, writable: true, enumerable: false });
    Object.defineProperty(this, '__snap', { value: isNew ? null : snapshot(raw), writable: true, enumerable: false });
    Object.assign(this, raw);
    attachArrayHelpers(model.schema, this);
  }

  get id() { return this._id; }
  set id(_v) { /* virtual: ignored, like Mongoose */ }
  get isNew() { return this.__isNew; }

  toObject() {
    const out = {};
    for (const k of Object.keys(this)) if (this[k] !== undefined) out[k] = toPlain(this[k]);
    return out;
  }
  toJSON() { return this.toObject(); }
  markModified() { /* changes are detected automatically */ }

  async populate(path, select) {
    await populateObjects(this.__model, [this], normalizePopulate(path, select), false);
    return this;
  }

  async deleteOne() {
    await getStore().delete(this.__model.collectionName, this._id);
    return { acknowledged: true, deletedCount: 1 };
  }

  async save() {
    const model = this.__model;
    const schema = model.schema;
    const store_ = getStore();
    const current = depopulate(ownFields(this));

    if (this.__isNew) {
      const errors = [];
      const data = buildObject(schema, current, { errors });
      if (errors.length) throw new ValidationError(model.modelName, errors);
      const id = this._id ? String(this._id) : newId();
      await model._checkUnique({ ...data, _id: id }, id, null);
      await store_.set(model.collectionName, id, data);
      this._id = id;
      for (const k of Object.keys(this)) if (k !== '_id' && !(k in data)) delete this[k];
      for (const k of Object.keys(data)) if (!isPopulatedValue(this[k])) this[k] = data[k];
      this.__isNew = false;
      this.__snap = snapshot(data);
      attachArrayHelpers(schema, this);
      return this;
    }

    const snap = this.__snap || {};
    const keys = new Set([...Object.keys(current), ...Object.keys(snap)]);
    keys.delete('_id');
    const changed = [...keys].filter((k) => schema.paths[k] && !deepEqual(current[k], snap[k]));
    if (!changed.length) return this;

    const errors = [];
    const cast = castKeys(schema, current, changed, errors);
    if (errors.length) throw new ValidationError(model.modelName, errors);
    await model._checkUnique({ ...snap, ...cast, _id: this._id }, this._id, new Set(changed));

    const set = {};
    const unset = [];
    for (const k of changed) {
      if (cast[k] === undefined) unset.push(k);
      else set[k] = cast[k];
    }
    if (schema.timestamps) set.updatedAt = new Date();
    await store_.update(model.collectionName, this._id, { set, unset, inc: {} });

    const nextSnap = { ...snap };
    for (const k of changed) { if (cast[k] === undefined) delete nextSnap[k]; else nextSnap[k] = cast[k]; }
    if (set.updatedAt) nextSnap.updatedAt = set.updatedAt;
    for (const k of [...changed, ...(set.updatedAt ? ['updatedAt'] : [])]) {
      if (isPopulatedValue(this[k])) continue;
      const v = k === 'updatedAt' ? set.updatedAt : cast[k];
      if (v === undefined) delete this[k]; else this[k] = v;
    }
    this.__snap = snapshot(nextSnap);
    attachArrayHelpers(schema, this);
    return this;
  }
}

const ownFields = (doc) => { const o = {}; for (const k of Object.keys(doc)) o[k] = doc[k]; return o; };
const snapshot = (raw) => { const s = clone(raw); delete s._id; return s; };

function isPopulatedValue(v) {
  if (v instanceof Document) return true;
  return Array.isArray(v) && v.some((x) => x instanceof Document);
}

// Turn populated documents back into plain ids (used before diffing / saving).
function depopulate(v) {
  if (v instanceof Document) return v._id;
  if (Array.isArray(v)) return v.map(depopulate);
  if (isPlainObject(v)) {
    const o = {};
    for (const k of Object.keys(v)) o[k] = depopulate(v[k]);
    return o;
  }
  return v;
}

function toPlain(v) {
  if (v instanceof Document) return v.toObject();
  if (Array.isArray(v)) return v.map(toPlain);
  if (v instanceof Date) return new Date(v.getTime());
  if (isPlainObject(v)) {
    const o = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = toPlain(v[k]);
    return o;
  }
  return v;
}

// replies.id(replyId) support for arrays of embedded documents.
function attachArrayHelpers(schema, doc) {
  for (const [key, def] of Object.entries(schema.paths)) {
    if (def.kind === 'array' && def.of.kind === 'subdoc' && Array.isArray(doc[key])) {
      Object.defineProperty(doc[key], 'id', {
        value(id) { return this.find((el) => el && String(el._id) === String(id)) || null; },
        enumerable: false, configurable: true, writable: true,
      });
    }
  }
}

// ---- selection / projection -----------------------------------------------

function parseSelect(spec) {
  const sel = { inc: new Set(), exc: new Set(), plus: new Set() };
  if (!spec) return sel;
  const add = (token, include) => {
    if (token.startsWith('+')) sel.plus.add(token.slice(1));
    else if (token.startsWith('-')) sel.exc.add(token.slice(1));
    else if (include) sel.inc.add(token); else sel.exc.add(token);
  };
  if (typeof spec === 'string') spec.split(/\s+/).filter(Boolean).forEach((t) => add(t, true));
  else for (const [k, v] of Object.entries(spec)) add(k, !!v);
  return sel;
}
function mergeSelect(a, b) {
  for (const k of ['inc', 'exc', 'plus']) for (const x of b[k]) a[k].add(x);
  return a;
}

// Apply defaults, hide select:false fields and honour select()/projection.
function finalizeRaw(model, raw, sel) {
  const schema = model.schema;
  const out = raw;
  for (const [key, def] of Object.entries(schema.paths)) {
    if (out[key] === undefined) {
      const d = getDefault(def);
      if (d !== undefined) out[key] = d;
    }
  }
  const s = sel || { inc: new Set(), exc: new Set(), plus: new Set() };
  for (const [key, def] of Object.entries(schema.paths)) {
    if (def.select === false && !s.plus.has(key) && !s.inc.has(key)) delete out[key];
  }
  if (s.inc.size) {
    const keep = new Set(['_id', ...[...s.inc].map((p) => p.split('.')[0]), ...s.plus]);
    for (const k of Object.keys(out)) if (!keep.has(k)) delete out[k];
  }
  for (const p of s.exc) if (p !== '_id') unsetPath(out, p);
  return out;
}

// ---- populate --------------------------------------------------------------

function normalizePopulate(path, select) {
  if (Array.isArray(path)) return path.flatMap((p) => normalizePopulate(p));
  if (path === undefined || path === null) return [];
  if (typeof path === 'string') {
    return path.split(/\s+/).filter(Boolean).map((p) => ({ path: p, select, populate: [] }));
  }
  return [{ path: path.path, select: path.select, populate: normalizePopulate(path.populate) }];
}

async function populateObjects(model, objs, specs, lean) {
  for (const spec of specs) await populateOne(model, objs.filter(Boolean), spec, lean);
}

async function populateOne(model, objs, spec, lean) {
  const parts = spec.path.split('.');
  let containers = objs;
  let schema = model.schema;
  for (let i = 0; i < parts.length - 1; i++) {
    const def = schema.paths[parts[i]];
    if (!def) return;
    const sub = def.kind === 'array' ? def.of : def;
    if (sub.kind !== 'subdoc') return;
    containers = containers.flatMap((c) => {
      const v = c[parts[i]];
      return v === null || v === undefined ? [] : (Array.isArray(v) ? v : [v]);
    });
    schema = sub.schema;
  }
  const key = parts[parts.length - 1];
  const def = schema.paths[key];
  if (!def) return;
  const elementDef = def.kind === 'array' ? def.of : def;
  const refName = elementDef.ref || def.ref;
  if (!refName) throw new Error(`Cannot populate "${spec.path}": the path has no ref.`);
  const refModel = models[refName];
  if (!refModel) throw new Error(`Cannot populate "${spec.path}": model ${refName} is not registered.`);

  const ids = new Set();
  const collect = (x) => { if (typeof x === 'string' && x) ids.add(x); };
  for (const c of containers) {
    const v = c[key];
    if (Array.isArray(v)) v.forEach(collect); else collect(v);
  }
  const rows = await refModel._fetchByIds([...ids], spec.select);
  const docs = rows.map((r) => (lean ? r : refModel._hydrate(r)));
  if (spec.populate.length) await populateObjects(refModel, docs, spec.populate, lean);
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  for (const c of containers) {
    const v = c[key];
    if (Array.isArray(v)) c[key] = v.map((x) => (typeof x === 'string' ? (byId.get(x) || null) : x)).filter((x) => x !== null);
    else if (typeof v === 'string') c[key] = byId.get(v) || null;
  }
}

// ---- Query -----------------------------------------------------------------

class Query {
  constructor(model, filter, one) {
    this.model = model;
    this._filter = filter || {};
    this._one = !!one;
    this._sel = parseSelect(null);
    this._pop = [];
    this._sort = [];
    this._limit = null;
    this._skip = 0;
    this._lean = false;
  }
  select(spec) { mergeSelect(this._sel, parseSelect(spec)); return this; }
  populate(path, select) { this._pop.push(...normalizePopulate(path, select)); return this; }
  sort(spec) { this._sort.push(...parseSort(spec)); return this; }
  limit(n) { this._limit = Number(n); return this; }
  skip(n) { this._skip = Number(n) || 0; return this; }
  lean() { this._lean = true; return this; }
  where(filter) { Object.assign(this._filter, filter); return this; }

  async exec() {
    const model = this.model;
    const filter = castFilter(model.schema, this._filter);
    const limit = this._one ? 1 : (Number.isFinite(this._limit) && this._limit > 0 ? this._limit : null);
    let rows = await model._fetchRaw(filter, { sort: this._sort, limit, skip: this._skip });
    // Like Mongoose, populating a path keeps it even when select() did not list it.
    if (this._sel.inc.size) for (const spec of this._pop) this._sel.inc.add(spec.path.split('.')[0]);
    rows = rows.map((r) => finalizeRaw(model, r, this._sel));
    if (this._pop.length) {
      const holders = this._lean ? rows : rows.map((r) => model._hydrate(r));
      await populateObjects(model, holders, this._pop, this._lean);
      return this._one ? (holders[0] || null) : holders;
    }
    const out = this._lean ? rows : rows.map((r) => model._hydrate(r));
    return this._one ? (out[0] || null) : out;
  }
  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(reject) { return this.exec().catch(reject); }
  finally(fn) { return this.exec().finally(fn); }
}

// ---- Model -----------------------------------------------------------------

function applyUpdateOps(doc, update) {
  const ops = Object.keys(update).some((k) => k.startsWith('$')) ? update : { $set: update };
  for (const [op, fields] of Object.entries(ops)) {
    for (const [path, val] of Object.entries(fields)) {
      const cur = getPath(doc, path);
      switch (op) {
        case '$set': setPath(doc, path, val); break;
        case '$unset': unsetPath(doc, path); break;
        case '$inc': setPath(doc, path, (Number(cur) || 0) + Number(val)); break;
        case '$push': setPath(doc, path, [...(cur || []), val]); break;
        case '$addToSet': setPath(doc, path, (cur || []).some((x) => deepEqual(x, val)) ? cur : [...(cur || []), val]); break;
        case '$pull': setPath(doc, path, (cur || []).filter((x) => !deepEqual(x, val))); break;
        default: throw new Error(`Unsupported update operator ${op}`);
      }
    }
  }
}

function createModel(name, schema) {
  const collectionName = pluralize(name);

  function Model(data) {
    return new Document(Model, withDefaults(schema, data), { isNew: true });
  }
  Model.modelName = name;
  Model.schema = schema;
  Model.collectionName = collectionName;

  Model._hydrate = (raw) => new Document(Model, raw, { isNew: false });

  // Returns raw rows ({_id, ...fields}) that match the (already cast) filter.
  Model._fetchRaw = async (filter, { sort = [], limit = null, skip = 0 } = {}) => {
    const s = getStore();
    const plan = planFilter(schema, filter);
    if (plan && plan.empty) return [];
    let rows;
    if (plan && plan.kind === 'ids') rows = await s.getAll(collectionName, plan.ids);
    else if (plan && plan.kind === 'where') {
      rows = await s.query(collectionName, { where: { field: plan.field, op: plan.op, value: plan.value } });
    } else {
      const only = sort.length === 1 ? sort[0] : null;
      const def = only && schema.paths[only[0]];
      const orderable = only && !Object.keys(filter).length && limit && (only[0] === 'createdAt' || only[0] === 'updatedAt' || (def && (def.required || def.default !== undefined)));
      rows = await s.query(collectionName, orderable ? { orderBy: { field: only[0], dir: only[1] === -1 ? 'desc' : 'asc' }, limit: limit + skip } : {});
    }
    rows = rows.map((r) => ({ ...r.data, _id: r.id })).filter((r) => matches(r, filter));
    rows = sortRows(rows, sort);
    if (skip) rows = rows.slice(skip);
    if (limit) rows = rows.slice(0, limit);
    return rows;
  };

  Model._fetchByIds = async (ids, select) => {
    if (!ids.length) return [];
    const sel = parseSelect(select);
    const rows = await getStore().getAll(collectionName, ids);
    return rows.map((r) => finalizeRaw(Model, { ...r.data, _id: r.id }, sel));
  };

  Model._checkUnique = async (values, selfId, changedKeys) => {
    for (const idx of schema.uniques) {
      if (changedKeys && !idx.fields.some((f) => changedKeys.has(f.split('.')[0]))) continue;
      const cond = {};
      let skip = false;
      for (const f of idx.fields) {
        const v = getPath(values, f);
        if (v === null || v === undefined) { skip = true; break; }
        cond[f] = v;
      }
      if (skip) continue;
      if (idx.partial && !matches(values, castFilter(schema, idx.partial))) continue;
      const filter = castFilter(schema, { ...cond, ...(idx.partial || {}), _id: { $ne: String(selfId) } });
      const found = await Model._fetchRaw(filter, { limit: 1 });
      if (found.length) {
        const err = new Error(`E11000 duplicate key error collection: ${collectionName} index: ${idx.fields.join('_')}_1 dup key: ${JSON.stringify(cond)}`);
        err.code = 11000;
        err.status = 409;
        err.keyValue = cond;
        throw err;
      }
    }
  };

  // ---- statics ----
  Model.find = (filter) => new Query(Model, filter, false);
  Model.findOne = (filter) => new Query(Model, filter, true);
  Model.findById = (id) => {
    if (id === null || id === undefined) return new Query(Model, { _id: { $in: [] } }, true);
    return new Query(Model, { _id: String(id) }, true);
  };

  Model.create = async (data) => {
    if (Array.isArray(data)) {
      const out = [];
      for (const d of data) out.push(await Model(d).save());
      return out;
    }
    return Model(data).save();
  };
  Model.insertMany = (arr) => Promise.all(arr.map((d) => Model(d).save()));

  Model.countDocuments = async (filter = {}) => {
    const cast = castFilter(schema, filter);
    if (!Object.keys(cast).length && getStore().countAll) return getStore().countAll(collectionName);
    return (await Model._fetchRaw(cast)).length;
  };
  Model.exists = async (filter) => {
    const rows = await Model._fetchRaw(castFilter(schema, filter), { limit: 1 });
    return rows.length ? { _id: rows[0]._id } : null;
  };
  Model.distinct = async (field, filter = {}) => {
    const rows = await Model._fetchRaw(castFilter(schema, filter));
    const seen = new Map();
    for (const r of rows) {
      for (const v of resolvePath(r, field)) {
        if (v === undefined || v === null || Array.isArray(v)) continue;
        seen.set(v instanceof Date ? `d:${v.getTime()}` : `${typeof v}:${v}`, v);
      }
    }
    return [...seen.values()];
  };

  Model.updateOne = async (filter, update, options = {}) => {
    if (options.upsert) throw new Error('upsert is not supported by the Firestore data layer.');
    const rows = await Model._fetchRaw(castFilter(schema, filter), { limit: 1 });
    if (!rows.length) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    await applyUpdate(Model, rows[0], update);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  };
  Model.updateMany = async (filter, update) => {
    const rows = await Model._fetchRaw(castFilter(schema, filter));
    for (const row of rows) await applyUpdate(Model, row, update);
    return { acknowledged: true, matchedCount: rows.length, modifiedCount: rows.length };
  };

  const updateDoc = async (query, update, options = {}) => {
    const doc = await query;
    if (!doc) return null;
    const before = options.new ? null : doc.toObject();
    const target = clone(depopulate(ownFields(doc)));
    applyUpdateOps(target, update);
    for (const k of Object.keys(target)) if (k !== '_id' && !deepEqual(target[k], doc[k])) doc[k] = target[k];
    for (const k of Object.keys(doc)) if (k !== '_id' && target[k] === undefined) delete doc[k];
    await doc.save();
    return options.new ? doc : Model._hydrate(before);
  };
  Model.findByIdAndUpdate = (id, update, options) => updateDoc(Model.findById(id), update, options);
  Model.findOneAndUpdate = (filter, update, options) => updateDoc(Model.findOne(filter), update, options);

  Model.deleteOne = async (filter) => {
    const rows = await Model._fetchRaw(castFilter(schema, filter), { limit: 1 });
    for (const r of rows) await getStore().delete(collectionName, r._id);
    return { acknowledged: true, deletedCount: rows.length };
  };
  Model.deleteMany = async (filter = {}) => {
    const rows = await Model._fetchRaw(castFilter(schema, filter));
    await Promise.all(rows.map((r) => getStore().delete(collectionName, r._id)));
    return { acknowledged: true, deletedCount: rows.length };
  };
  Model.findByIdAndDelete = async (id) => {
    const doc = await Model.findById(id);
    if (doc) await getStore().delete(collectionName, doc._id);
    return doc;
  };
  Model.findOneAndDelete = async (filter) => {
    const doc = await Model.findOne(filter);
    if (doc) await getStore().delete(collectionName, doc._id);
    return doc;
  };

  return Model;
}

// Direct (non-transactional) update used by updateOne / updateMany.
async function applyUpdate(model, row, update) {
  const ops = Object.keys(update).some((k) => k.startsWith('$')) ? update : { $set: update };
  const out = { set: {}, unset: [], inc: {} };
  const rmw = clone(row);
  for (const [op, fields] of Object.entries(ops)) {
    for (const [path, val] of Object.entries(fields)) {
      const def = getPathDef(model.schema, path);
      if (op === '$set') {
        const errors = [];
        out.set[path] = def ? castPath(def, val, path, errors) : val;
        if (errors.length) throw new ValidationError(model.modelName, errors);
      } else if (op === '$unset') out.unset.push(path);
      else if (op === '$inc') out.inc[path] = Number(val);
      else if (['$push', '$addToSet', '$pull'].includes(op)) {
        applyUpdateOps(rmw, { [op]: { [path]: val } });
        out.set[path] = getPath(rmw, path);
      } else throw new Error(`Unsupported update operator ${op}`);
    }
  }
  if (model.schema.timestamps && out.set.updatedAt === undefined) out.set.updatedAt = new Date();
  await getStore().update(model.collectionName, row._id, out);
}

function model(name, schema) {
  if (schema === undefined) {
    if (!models[name]) throw new Error(`Model ${name} has not been registered.`);
    return models[name];
  }
  models[name] = createModel(name, schema);
  return models[name];
}

// ObjectId stand-in so legacy code like `new mongoose.Types.ObjectId(x)` keeps working.
class ObjectId {
  constructor(id) { this.id = id === undefined ? newId() : String(id); }
  toString() { return this.id; }
  toJSON() { return this.id; }
}

module.exports = {
  Schema, model, models, Document, Query, ValidationError,
  connect, disconnect, useStore, connection, acquireLock,
  isValidObjectId: isValidId,
  Types: { ObjectId },
  newId,
  _internals: { finalizeRaw, parseSelect, normalizePopulate, populateObjects, isOperatorObject, ObjectIdType, MixedType },
};
