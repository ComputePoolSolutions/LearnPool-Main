'use strict';
/**
 * Where passwords live and how they are checked.
 *
 *  firebase  Passwords are stored and verified by Firebase Authentication (email/password accounts).
 *            The Firebase Auth user id (uid) is the same as the Firestore user document id, so one
 *            identity ties both together. No password (or hash) is kept in the Firestore profile.
 *            Setting a password uses the Admin SDK; checking one uses Firebase's own sign-in endpoint
 *            (Identity Toolkit "signInWithPassword"), which is how a server verifies a password.
 *  local     The older behaviour: a bcrypt hash kept on the user's Firestore document (never plain text).
 *
 * AUTH_PROVIDER = firebase | local | auto (default). "auto" uses Firebase as soon as
 * FIREBASE_WEB_API_KEY (or the Auth emulator) is configured, otherwise local.
 *
 * Existing accounts migrate lazily: the first time someone signs in with a password that matches their
 * old bcrypt hash, the password is moved into Firebase Authentication and the hash is removed.
 */
const bcrypt = require('bcryptjs');

const hooks = { fetch: null, auth: null };   // injected by tests only

class CredentialError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; this.expose = true; }
}

const webApiKey = () => process.env.FIREBASE_WEB_API_KEY || '';
const emulatorHost = () => process.env.FIREBASE_AUTH_EMULATOR_HOST || '';
const useFirebase = () => {
  const mode = String(process.env.AUTH_PROVIDER || 'auto').toLowerCase();
  if (mode === 'firebase') return true;
  if (mode === 'local') return false;
  return !!(webApiKey() || emulatorHost());
};
const providerName = () => (useFirebase() ? 'firebase' : 'local');

// ---- Firebase Authentication (server side) -------------------------------------------------------
function adminAuth() {
  if (hooks.auth) return hooks.auth;
  const store = require('../db').getStore ? require('../db').getStore() : null;
  if (!store || !store.auth) throw new CredentialError(503, 'Firebase Authentication is not available. Check the Firebase credentials in backend/.env.');
  return store.auth;
}

const notEnabled = () => new CredentialError(503, 'Firebase Authentication is not turned on for this project. In the Firebase console open Authentication → Get started → Sign-in method and enable Email/Password.', 'AUTH_NOT_ENABLED');
function mapAdminError(error) {
  const code = String(error && error.code || '');
  if (code === 'auth/configuration-not-found' || code === 'auth/operation-not-allowed') return notEnabled();
  if (code === 'auth/invalid-password' || code === 'auth/weak-password') return new CredentialError(400, 'Choose a stronger password (at least 8 characters).', 'WEAK_PASSWORD');
  if (code === 'auth/invalid-email') return new CredentialError(400, 'That email address is not valid.', 'INVALID_EMAIL');
  return error;
}

// Make sure a Firebase Auth user with this uid, email and password exists.
async function ensureAuthUser(user, password) {
  const auth = adminAuth();
  const uid = String(user._id);
  const props = { email: user.email, password, displayName: String(user.name || '').slice(0, 100), disabled: false };
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await auth.updateUser(uid, props); return; }
    catch (e) {
      const code = String(e && e.code || '');
      if (code === 'auth/user-not-found') {
        try { await auth.createUser({ uid, ...props }); return; }
        catch (e2) { if (String(e2 && e2.code) !== 'auth/email-already-exists') throw mapAdminError(e2); }
      } else if (code !== 'auth/email-already-exists') throw mapAdminError(e);
      // The email is already taken by a DIFFERENT Firebase user (for example someone registered it directly
      // against Firebase). LearnPool's own user record is the source of truth, so that stray login is removed.
      const other = await auth.getUserByEmail(user.email).catch(() => null);
      if (other && other.uid !== uid) await auth.deleteUser(other.uid);
    }
  }
  throw new CredentialError(409, 'This email address is already registered with Firebase under another account.', 'EMAIL_CONFLICT');
}

// Check a password with Firebase Authentication. Returns { ok, reason, uid }.
async function firebaseVerify(email, password) {
  const key = webApiKey() || (emulatorHost() ? 'emulator' : '');
  if (!key) throw new CredentialError(503, 'FIREBASE_WEB_API_KEY is not set in backend/.env (Firebase console → Project settings → General → Web API Key).', 'NO_WEB_API_KEY');
  const base = emulatorHost() ? `http://${emulatorHost()}/identitytoolkit.googleapis.com` : 'https://identitytoolkit.googleapis.com';
  const doFetch = hooks.fetch || globalThis.fetch;
  let res;
  try {
    res = await doFetch(`${base}/v1/accounts:signInWithPassword?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
  } catch { throw new CredentialError(503, 'LearnPool could not reach Firebase Authentication. Check your internet connection and try again.', 'AUTH_UNREACHABLE'); }
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.localId) return { ok: true, uid: String(data.localId) };
  const message = String(data && data.error && data.error.message || '');
  if (/^(EMAIL_NOT_FOUND|INVALID_PASSWORD|INVALID_LOGIN_CREDENTIALS|MISSING_PASSWORD|INVALID_EMAIL)/.test(message)) return { ok: false, reason: 'invalid' };
  if (/^USER_DISABLED/.test(message)) return { ok: false, reason: 'disabled' };
  if (/^TOO_MANY_ATTEMPTS/.test(message)) return { ok: false, reason: 'throttled' };
  if (/^(OPERATION_NOT_ALLOWED|PASSWORD_LOGIN_DISABLED|CONFIGURATION_NOT_FOUND)/.test(message)) throw notEnabled();
  if (/API key|API_KEY/i.test(message)) throw new CredentialError(503, 'The FIREBASE_WEB_API_KEY in backend/.env is not valid for this Firebase project.', 'BAD_WEB_API_KEY');
  throw new CredentialError(502, 'Firebase Authentication could not check the password right now. Please try again.', 'AUTH_ERROR');
}

// ---- public API ------------------------------------------------------------------------------------
// Has this account got a password that can actually be checked? (Demo accounts have none.)
const hasCredential = user => !!user && !user.isDemo && (user.credentialProvider === 'firebase' || !!user.password);

// A permanent password the person chose. Older accounts without the field count as set up
// unless they are demo accounts or still on an administrator-issued initial password.
const passwordSetupComplete = user => (typeof user.passwordSetupComplete === 'boolean' ? user.passwordSetupComplete : (!user.isDemo && !user.mustChangePassword));

/**
 * Verify `password` for `user`. May update (and save) the user while migrating an old hash.
 * Resolves { ok } or { ok:false, reason: 'invalid' | 'no_credential' | 'disabled' | 'throttled' }.
 */
async function verify(user, password) {
  if (!user || typeof password !== 'string' || !password) return { ok: false, reason: 'invalid' };
  if (useFirebase()) {
    if (user.credentialProvider !== 'firebase') {
      // Old account: its password is still a bcrypt hash. If the typed password matches, move it to Firebase.
      if (!user.password) return { ok: false, reason: 'no_credential' };
      if (!(await bcrypt.compare(password, user.password))) return { ok: false, reason: 'invalid' };
      await setPassword(user, password);
      await user.save();
      return { ok: true, migrated: true };
    }
    const res = await firebaseVerify(user.email, password);
    if (res.ok && res.uid !== String(user._id)) return { ok: false, reason: 'invalid' };   // someone else's Firebase login
    return res;
  }
  if (user.credentialProvider === 'firebase' || !user.password) return { ok: false, reason: 'no_credential' };
  return (await bcrypt.compare(password, user.password)) ? { ok: true } : { ok: false, reason: 'invalid' };
}

/** Store a new permanent password for `user` (the caller saves the user document afterwards). */
async function setPassword(user, password) {
  if (useFirebase()) {
    await ensureAuthUser(user, password);
    user.credentialProvider = 'firebase';
    user.password = undefined;   // nothing password-like stays in the Firestore profile
  } else {
    user.password = await bcrypt.hash(password, 12);
    user.credentialProvider = 'local';
  }
  user.passwordChangedAt = new Date();
}

// Keep the Firebase login in step when an admin changes someone's email address.
async function syncEmail(user) {
  if (!useFirebase() || user.credentialProvider !== 'firebase') return;
  try { await adminAuth().updateUser(String(user._id), { email: user.email }); }
  catch (e) {
    if (String(e && e.code) === 'auth/email-already-exists') throw new CredentialError(409, 'An account with this email already exists.', 'EMAIL_CONFLICT');
    if (String(e && e.code) === 'auth/user-not-found') return;
    throw mapAdminError(e);
  }
}

// Remove the Firebase login when an account is deleted.
async function removeCredential(user) {
  if (!useFirebase() || user.credentialProvider !== 'firebase') return;
  try { await adminAuth().deleteUser(String(user._id)); } catch (e) { if (String(e && e.code) !== 'auth/user-not-found') throw e; }
}

module.exports = { CredentialError, providerName, useFirebase, hasCredential, passwordSetupComplete, verify, setPassword, syncEmail, removeCredential, _hooks: hooks };
