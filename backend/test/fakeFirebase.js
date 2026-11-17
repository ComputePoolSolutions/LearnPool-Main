'use strict';
// An in-memory stand-in for Firebase Authentication, used by the tests. It behaves like the two real
// interfaces LearnPool uses: the Admin SDK (createUser / updateUser / ...) and the Identity Toolkit
// "signInWithPassword" endpoint. Passwords exist here only because it is a test double.
function create() {
  const users = new Map();   // uid -> { uid, email, password, displayName, disabled }
  const state = { notEnabled: false, down: false, throttle: false, calls: [] };
  const err = (code, message) => Object.assign(new Error(message || code), { code });
  const byEmail = email => [...users.values()].find(u => u.email === String(email).toLowerCase());
  const guard = () => { if (state.notEnabled) throw err('auth/configuration-not-found', 'CONFIGURATION_NOT_FOUND'); };

  const auth = {
    async getUser(uid) { guard(); const u = users.get(uid); if (!u) throw err('auth/user-not-found'); return { ...u }; },
    async getUserByEmail(email) { guard(); const u = byEmail(email); if (!u) throw err('auth/user-not-found'); return { ...u }; },
    async createUser({ uid, email, password, displayName, disabled }) {
      guard(); state.calls.push(['createUser', uid]);
      if (!password || password.length < 6) throw err('auth/invalid-password');
      if (byEmail(email)) throw err('auth/email-already-exists');
      if (users.has(uid)) throw err('auth/uid-already-exists');
      users.set(uid, { uid, email: String(email).toLowerCase(), password, displayName, disabled: !!disabled });
      return { uid };
    },
    async updateUser(uid, props) {
      guard(); state.calls.push(['updateUser', uid]);
      const u = users.get(uid);
      if (!u) throw err('auth/user-not-found');
      if (props.password !== undefined && props.password.length < 6) throw err('auth/invalid-password');
      if (props.email) { const other = byEmail(props.email); if (other && other.uid !== uid) throw err('auth/email-already-exists'); }
      Object.assign(u, { ...props, email: props.email ? String(props.email).toLowerCase() : u.email });
      return { uid };
    },
    async deleteUser(uid) { guard(); state.calls.push(['deleteUser', uid]); if (!users.delete(uid)) throw err('auth/user-not-found'); },
  };

  // Identity Toolkit: POST .../accounts:signInWithPassword
  async function fetch(url, init) {
    if (state.down) throw new Error('network down');
    const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (!/accounts:signInWithPassword/.test(url)) return respond(404, {});
    if (state.notEnabled) return respond(400, { error: { message: 'OPERATION_NOT_ALLOWED' } });
    if (state.throttle) return respond(400, { error: { message: 'TOO_MANY_ATTEMPTS_TRY_LATER' } });
    const { email, password } = JSON.parse(init.body);
    const u = byEmail(email);
    if (!u) return respond(400, { error: { message: 'EMAIL_NOT_FOUND' } });
    if (u.disabled) return respond(400, { error: { message: 'USER_DISABLED' } });
    if (u.password !== password) return respond(400, { error: { message: 'INVALID_LOGIN_CREDENTIALS' } });
    return respond(200, { localId: u.uid, email: u.email, idToken: 'token', registered: true });
  }
  return { auth, fetch, users, state };
}
module.exports = { create };
