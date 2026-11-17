'use strict';
/**
 * Offline test of the credential layer (utils/credentials.js): Firebase Authentication mode, local mode,
 * and the lazy move of an old bcrypt hash into Firebase. Uses in-memory fakes, so no Firebase project
 * is needed. Run with:  node test/credentials.js
 */
const assert = require('assert');
const db = require('../db');
db.useStore(require('./memoryStore').create());
const User = require('../models/User');
const credentials = require('../utils/credentials');
const fake = require('./fakeFirebase').create();
credentials._hooks.auth = fake.auth;
credentials._hooks.fetch = fake.fetch;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const useFirebase = () => { process.env.AUTH_PROVIDER = 'firebase'; process.env.FIREBASE_WEB_API_KEY = 'test-key'; };
const useLocal = () => { process.env.AUTH_PROVIDER = 'local'; delete process.env.FIREBASE_WEB_API_KEY; };
const rejectsWith = async (fn, status, pattern) => {
  let e; try { await fn(); } catch (x) { e = x; }
  assert(e, 'expected an error'); assert.strictEqual(e.status, status); if (pattern) assert.match(e.message, pattern); return e;
};
const mk = (name, email, extra = {}) => User.create({ name, email, role: 'student', ...extra });

test('provider selection', () => {
  delete process.env.AUTH_PROVIDER; delete process.env.FIREBASE_WEB_API_KEY; delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  assert.strictEqual(credentials.providerName(), 'local');
  process.env.FIREBASE_WEB_API_KEY = 'k';
  assert.strictEqual(credentials.providerName(), 'firebase', 'auto picks Firebase once a web API key exists');
  process.env.AUTH_PROVIDER = 'local';
  assert.strictEqual(credentials.providerName(), 'local');
});

test('Firebase mode: password lives in Firebase Authentication, not in Firestore', async () => {
  useFirebase();
  const u = await mk('Ada Lovelace', 'ada@example.com');
  await credentials.setPassword(u, 'Permanent#1');
  await u.save();
  const fb = fake.users.get(String(u._id));
  assert.ok(fb, 'a Firebase Auth user exists with the same uid as the Firestore document');
  assert.strictEqual(fb.email, 'ada@example.com'); assert.strictEqual(fb.password, 'Permanent#1');
  const stored = db.getStore();
  const raw = (await stored.getAll('users', [String(u._id)]))[0].data;
  assert.strictEqual(raw.password, undefined, 'no password or hash in the Firestore profile');
  assert.ok(!JSON.stringify(raw).includes('Permanent#1'));
  assert.strictEqual(raw.credentialProvider, 'firebase');
  assert.strictEqual((await credentials.verify(u, 'Permanent#1')).ok, true);
  assert.deepStrictEqual(await credentials.verify(u, 'wrong-password'), { ok: false, reason: 'invalid' });
  assert.strictEqual((await credentials.verify(u, '')).ok, false);
});

test('Firebase mode: changing the password updates the same Firebase user', async () => {
  const u = await User.findOne({ email: 'ada@example.com' });
  await credentials.setPassword(u, 'Another#Pass2'); await u.save();
  assert.strictEqual((await credentials.verify(u, 'Permanent#1')).ok, false);
  assert.strictEqual((await credentials.verify(u, 'Another#Pass2')).ok, true);
  assert.strictEqual([...fake.users.values()].filter(x => x.email === 'ada@example.com').length, 1, 'no duplicate Firebase user');
});

test('a password belonging to a different Firebase user is never accepted', async () => {
  const u = await User.findOne({ email: 'ada@example.com' });
  fake.users.get(String(u._id)).uid = 'someone-else';        // simulate the email now belonging to another uid
  assert.strictEqual((await credentials.verify(u, 'Another#Pass2')).ok, false);
  fake.users.get(String(u._id)).uid = String(u._id);
});

test('old bcrypt hashes move into Firebase on the first correct sign-in', async () => {
  const u = await mk('Old Account', 'old@example.com');
  u.password = await require('bcryptjs').hash('legacy-pass-1', 10);   // how accounts used to be stored
  await u.save();
  assert.deepStrictEqual(await credentials.verify(u, 'wrong-legacy'), { ok: false, reason: 'invalid' });
  assert.strictEqual(fake.users.has(String(u._id)), false, 'a wrong password migrates nothing');
  const r = await credentials.verify(u, 'legacy-pass-1');
  assert.deepStrictEqual(r, { ok: true, migrated: true });
  const raw = (await db.getStore().getAll('users', [String(u._id)]))[0].data;
  assert.strictEqual(raw.password, undefined, 'the hash is removed from Firestore'); assert.strictEqual(raw.credentialProvider, 'firebase');
  assert.strictEqual((await credentials.verify(await User.findById(u._id), 'legacy-pass-1')).ok, true, 'now verified by Firebase');
});

test('an account with no password cannot be verified', async () => {
  const u = await mk('No Password', 'nopass@example.com', { isDemo: true });
  assert.strictEqual(credentials.hasCredential(u), false);
  assert.deepStrictEqual(await credentials.verify(u, 'anything'), { ok: false, reason: 'no_credential' });
});

test('setup status: explicit flag first, sensible default for older accounts', () => {
  assert.strictEqual(credentials.passwordSetupComplete({ passwordSetupComplete: false }), false);
  assert.strictEqual(credentials.passwordSetupComplete({ passwordSetupComplete: true, isDemo: true }), true);
  assert.strictEqual(credentials.passwordSetupComplete({}), true, 'older accounts count as set up');
  assert.strictEqual(credentials.passwordSetupComplete({ isDemo: true }), false);
  assert.strictEqual(credentials.passwordSetupComplete({ mustChangePassword: true }), false);
});

test('a stray Firebase account on the same email is replaced, not trusted', async () => {
  const u = await mk('Real Owner', 'owner@example.com');
  fake.users.set('stray-uid', { uid: 'stray-uid', email: 'owner@example.com', password: 'attacker-pass', disabled: false });
  await credentials.setPassword(u, 'Owner#Pass3'); await u.save();
  assert.strictEqual(fake.users.has('stray-uid'), false);
  assert.strictEqual((await credentials.verify(u, 'attacker-pass')).ok, false);
  assert.strictEqual((await credentials.verify(u, 'Owner#Pass3')).ok, true);
});

test('Firebase problems become clear messages', async () => {
  const u = await mk('Err User', 'err@example.com');
  fake.state.notEnabled = true;
  await rejectsWith(() => credentials.setPassword(u, 'Whatever#1'), 503, /Authentication → Get started/);
  fake.state.notEnabled = false;
  const w = await mk('Weak', 'weak@example.com');
  await rejectsWith(() => credentials.setPassword(w, '123'), 400, /stronger password/);
  await credentials.setPassword(u, 'Fine#Pass4'); await u.save();
  fake.state.down = true;
  await rejectsWith(() => credentials.verify(u, 'Fine#Pass4'), 503, /could not reach Firebase/);
  fake.state.down = false; fake.state.throttle = true;
  assert.deepStrictEqual(await credentials.verify(u, 'Fine#Pass4'), { ok: false, reason: 'throttled' });
  fake.state.throttle = false; fake.state.notEnabled = true;
  await rejectsWith(() => credentials.verify(u, 'Fine#Pass4'), 503, /Email\/Password/);
  fake.state.notEnabled = false;
  delete process.env.FIREBASE_WEB_API_KEY;
  await rejectsWith(() => credentials.verify(u, 'Fine#Pass4'), 503, /FIREBASE_WEB_API_KEY/);
  useFirebase();
});

test('disabled Firebase users are reported', async () => {
  const u = await User.findOne({ email: 'err@example.com' });
  fake.users.get(String(u._id)).disabled = true;
  assert.deepStrictEqual(await credentials.verify(u, 'Fine#Pass4'), { ok: false, reason: 'disabled' });
});

test('changing an email updates the Firebase login too', async () => {
  const u = await mk('Mover', 'mover@example.com');
  await credentials.setPassword(u, 'Mover#Pass6'); await u.save();
  u.email = 'mover.new@example.com';
  await credentials.syncEmail(u);
  assert.strictEqual(fake.users.get(String(u._id)).email, 'mover.new@example.com');
  u.email = 'owner@example.com';   // already taken by another Firebase user
  await rejectsWith(() => credentials.syncEmail(u), 409, /already exists/);
});

test('removing an account removes its Firebase login', async () => {
  const u = await User.findOne({ email: 'ada@example.com' });
  await credentials.removeCredential(u);
  assert.strictEqual(fake.users.has(String(u._id)), false);
  await credentials.removeCredential(u);   // already gone: not an error
});

test('Local mode keeps the old, hashed behaviour', async () => {
  useLocal();
  const u = await mk('Local Person', 'local@example.com');
  await credentials.setPassword(u, 'Local#Pass5'); await u.save();
  assert.strictEqual(u.credentialProvider, 'local');
  assert.ok(u.password && u.password !== 'Local#Pass5', 'only a hash is stored');
  assert.strictEqual((await credentials.verify(u, 'Local#Pass5')).ok, true);
  assert.strictEqual((await credentials.verify(u, 'nope')).ok, false);
  const fbUser = await mk('Moved', 'moved@example.com', { credentialProvider: 'firebase' });
  assert.deepStrictEqual(await credentials.verify(fbUser, 'x'), { ok: false, reason: 'no_credential' }, 'a Firebase-managed account is not checked locally');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${(e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
