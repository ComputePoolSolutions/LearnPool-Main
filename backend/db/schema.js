'use strict';
const { isPlainObject, newId, clone } = require('./util');

// Sentinel "types" so model files can keep writing Schema.Types.ObjectId / Mixed.
function ObjectIdType() {}
function MixedType() {}

class ValidationError extends Error {
  constructor(modelName, messages) {
    super(`${modelName} validation failed: ${messages.join(', ')}`);
    this.name = 'ValidationError';
    this.status = 400;
    this.errors = messages;
  }
}

const OPTION_KEYS = ['required', 'default', 'enum', 'trim', 'lowercase', 'minlength', 'maxlength', 'min', 'max', 'unique', 'sparse', 'select', 'ref'];

class Schema {
  constructor(definition, options = {}) {
    this.options = options;
    this.timestamps = !!options.timestamps;
    this.paths = {};
    this.uniques = [];
    for (const [key, def] of Object.entries(definition)) {
      this.paths[key] = parsePath(def);
      if (this.paths[key].unique) this.uniques.push({ fields: [key], partial: null });
    }
  }
  // Only unique indexes matter here; everything else is a MongoDB tuning hint.
  index(spec, opts = {}) {
    if (opts.unique) this.uniques.push({ fields: Object.keys(spec), partial: opts.partialFilterExpression || null });
    return this;
  }
}
Schema.Types = { ObjectId: ObjectIdType, Mixed: MixedType };

function parsePath(def) {
  if (Array.isArray(def)) {
    return { kind: 'array', of: def.length ? parsePath(def[0]) : { kind: 'scalar', type: MixedType } };
  }
  if (def instanceof Schema) return { kind: 'subdoc', schema: def };
  if (typeof def === 'function') return { kind: 'scalar', type: def };
  if (isPlainObject(def)) {
    const t = def.type;
    const hasTypeKeyword = t !== undefined && (typeof t === 'function' || Array.isArray(t) || t instanceof Schema);
    if (hasTypeKeyword) {
      const inner = parsePath(t);
      const out = { ...inner };
      for (const k of OPTION_KEYS) if (def[k] !== undefined) out[k] = def[k];
      return out;
    }
    // A plain nested object (a field that happens to be called "type" is handled above).
    return { kind: 'subdoc', schema: new Schema(def) };
  }
  throw new Error('Unsupported schema definition');
}

function getDefault(def) {
  if (def.default !== undefined) {
    const v = typeof def.default === 'function' ? def.default() : def.default;
    return clone(v);
  }
  if (def.kind === 'array') return [];
  return undefined;
}

const describe = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
const castMsg = (type, v, path) => `Cast to ${type} failed for value "${describe(v)}" (type ${typeof v}) at path "${path}"`;

function castScalar(def, v, path, errors) {
  if (v === null || v === undefined) return v;
  const t = def.type;
  if (t === String) {
    let s;
    if (typeof v === 'string') s = v;
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
    else { errors.push(castMsg('string', v, path)); return v; }
    if (def.trim) s = s.trim();
    if (def.lowercase) s = s.toLowerCase();
    return s;
  }
  if (t === Number) {
    if (v === '') return null;
    const n = typeof v === 'number' ? v : (typeof v === 'string' || typeof v === 'boolean') ? Number(v) : NaN;
    if (Number.isNaN(n)) { errors.push(castMsg('Number', v, path)); return v; }
    return n;
  }
  if (t === Boolean) {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 1 || v === '1') return true;
    if (v === 'false' || v === 0 || v === '0') return false;
    errors.push(castMsg('boolean', v, path));
    return v;
  }
  if (t === Date) {
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) { errors.push(castMsg('date', v, path)); return v; }
    return d;
  }
  if (t === ObjectIdType) {
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v._id !== undefined && v._id !== null) return String(v._id);
    const s = String(v);
    if (s === '[object Object]') { errors.push(castMsg('ObjectId', v, path)); return v; }
    return s;
  }
  return v; // Mixed and anything unknown
}

function validateScalar(def, v, path, errors) {
  if (v === null || v === undefined) return;
  if (def.enum && !def.enum.includes(v)) errors.push(`\`${v}\` is not a valid enum value for path \`${path}\`.`);
  if (typeof v === 'string') {
    if (def.minlength !== undefined && v.length < def.minlength) errors.push(`Path \`${path}\` (\`${v}\`) is shorter than the minimum allowed length (${def.minlength}).`);
    if (def.maxlength !== undefined && v.length > def.maxlength) errors.push(`Path \`${path}\` (\`${v}\`) is longer than the maximum allowed length (${def.maxlength}).`);
  }
  if (typeof v === 'number') {
    if (def.min !== undefined && v < def.min) errors.push(`Path \`${path}\` (${v}) is less than minimum allowed value (${def.min}).`);
    if (def.max !== undefined && v > def.max) errors.push(`Path \`${path}\` (${v}) is more than maximum allowed value (${def.max}).`);
  }
}

const isEmpty = (def, v) => v === undefined || v === null || (def.kind === 'scalar' && def.type === String && v === '');

// Cast one value according to its definition. Returns the cast value and pushes problems onto `errors`.
function castPath(def, v, path, errors) {
  if (v === null || v === undefined) return v;
  if (def.kind === 'scalar') {
    const out = castScalar(def, v, path, errors);
    validateScalar(def, out, path, errors);
    return out;
  }
  if (def.kind === 'array') {
    const arr = Array.isArray(v) ? v : [v];
    return arr.map((el, i) => castElement(def.of, el, `${path}.${i}`, errors));
  }
  if (def.kind === 'subdoc') {
    if (!isPlainObject(v) && !(v && typeof v.toObject === 'function')) { errors.push(castMsg('Embedded', v, path)); return v; }
    return buildObject(def.schema, v, { prefix: `${path}.`, errors, withId: false });
  }
  return v;
}

function castElement(of, el, path, errors) {
  if (el === null || el === undefined) return el;
  if (of.kind === 'subdoc') {
    if (!isPlainObject(el) && !(el && typeof el.toObject === 'function')) { errors.push(castMsg('Embedded', el, path)); return el; }
    return buildObject(of.schema, el, { prefix: `${path}.`, errors, withId: of.schema.options._id !== false });
  }
  return castPath(of, el, path, errors);
}

// Build a complete, cast and validated object from raw input (defaults applied, unknown keys dropped).
function buildObject(schema, input, { prefix = '', errors, withId = false } = {}) {
  const src = input && typeof input.toObject === 'function' ? input.toObject() : (input || {});
  const out = {};
  for (const [key, def] of Object.entries(schema.paths)) {
    const path = prefix + key;
    let v = src[key];
    if (v === undefined) v = getDefault(def);
    v = castPath(def, v, path, errors);
    if (def.required && isEmpty(def, v)) errors.push(`Path \`${path}\` is required.`);
    if (v !== undefined) out[key] = v;
  }
  if (withId) out._id = src._id !== undefined && src._id !== null ? String(src._id) : newId();
  if (schema.timestamps) {
    const now = new Date();
    out.createdAt = src.createdAt ? new Date(src.createdAt) : now;
    out.updatedAt = src.updatedAt ? new Date(src.updatedAt) : now;
  }
  return out;
}

// Cast + validate only some top-level keys (used when saving an existing document).
function castKeys(schema, values, keys, errors) {
  const out = {};
  for (const key of keys) {
    const def = schema.paths[key];
    if (!def) continue;
    let v = values[key];
    v = castPath(def, v, key, errors);
    if (def.required && isEmpty(def, v)) errors.push(`Path \`${key}\` is required.`);
    out[key] = v;
  }
  return out;
}

// Defaults only (no cast, no validation) for `new Model(data)`.
function withDefaults(schema, data) {
  const out = clone(data || {});
  for (const [key, def] of Object.entries(schema.paths)) {
    if (out[key] === undefined) {
      const d = getDefault(def);
      if (d !== undefined) out[key] = d;
    }
  }
  return out;
}

// Look up a definition for a possibly dotted path ("data.courseId", "replies.author").
function getPathDef(schema, path) {
  const parts = path.split('.');
  let def = schema.paths[parts[0]];
  for (let i = 1; i < parts.length; i++) {
    if (!def) return undefined;
    if (def.kind === 'array') def = def.of;
    if (def.kind === 'subdoc') def = def.schema.paths[parts[i]];
    else if (def.kind === 'scalar' && def.type === MixedType) return { kind: 'scalar', type: MixedType, dotted: true };
    else return undefined;
  }
  return def;
}

module.exports = { Schema, ObjectIdType, MixedType, ValidationError, parsePath, getDefault, castPath, castKeys, buildObject, withDefaults, getPathDef, isEmpty };
