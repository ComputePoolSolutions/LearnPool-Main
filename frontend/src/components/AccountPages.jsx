import { useMemo, useRef, useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Eye, EyeOff } from 'lucide-react';
import { api, assetUrl, dateLabel, initials, normalizeRole, roleHome } from '../api.js';

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const errorText = (err, fallback) => err.response?.data?.message || fallback;

/* ------------------------------------------------------------------ avatar */
export function Avatar({ user, className = '' }) {
  const src = assetUrl(user?.profilePicture);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <span className={`avatar ${className}`.trim()}>{src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : initials(user?.name)}</span>;
}

/* ------------------------------------------------------------ shared layout */
function AuthLayout({ eyebrow, children }) {
  return <main className="auth-shell auth-v2">
    <section className="auth-photo">
      <Link className="brand light" to="/login"><span className="brand-mark">L</span>LearnPool</Link>
      <div className="auth-hero-content">
        <span className="eyebrow">A learning workspace built around people</span>
        <h1>Good learning<br />moves everyone<br />forward.</h1>
        <p>Courses, teaching and progress in one considered place.</p>
        <div className="auth-hero-points"><span><i />Structured courses</span><span><i />Connected learning</span><span><i />Clear progress</span></div>
      </div>
      <span className="photo-credit">LEARNPOOL · LEARN WITH INTENTION</span>
    </section>
    <section className="auth-panel">
      <div className="auth-top"><span className="eyebrow">{eyebrow}</span></div>
      {children}
    </section>
  </main>;
}

function PasswordInput({ name, label, value, onChange, autoComplete, placeholder, required = true }) {
  const [shown, setShown] = useState(false);
  return <label>{label}
    <span className="password-field">
      <input type={shown ? 'text' : 'password'} name={name} value={value} onChange={onChange} autoComplete={autoComplete} placeholder={placeholder} required={required} />
      <button type="button" className="password-toggle" onClick={() => setShown(v => !v)} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown}>{shown ? <EyeOff size={16} /> : <Eye size={16} />}</button>
    </span>
  </label>;
}

/* ------------------------------------------------------------- common login */
export function AuthPage({ onSuccess }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [demo, setDemo] = useState(false), [demoInstructors, setDemoInstructors] = useState(false), [autoDomains, setAutoDomains] = useState([]);
  useEffect(() => { api.get('/auth/config').then(r => { setDemo(!!r.data.data?.demoMode); setDemoInstructors(!!r.data.data?.demoInstructors); setAutoDomains(r.data.data?.autoProvisionDomains || []); }).catch(() => {}); }, []);

  const submit = async event => {
    event.preventDefault();
    setError(''); setMessage('');
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) { setError('Please enter your email and password.'); return; }
    if (!EMAIL_FORMAT.test(cleanEmail)) { setError('Please enter a valid email address.'); return; }
    setBusy(true);
    try {
      const { data } = await api.post('/auth/login', { email: cleanEmail, password });
      if (!data.token) { setError(data.message || 'Incorrect email or password.'); return; }
      setMessage(data.message || 'Redirecting to your dashboard.');
      onSuccess(data.token, data.user);   // the role in `data.user` comes from the database
    } catch (err) {
      setError(errorText(err, 'We could not reach LearnPool. Check your connection and try again.'));
    } finally { setBusy(false); }
  };

  return <AuthLayout eyebrow="SECURE LEARNING WORKSPACE">
    <div className="auth-card auth-card-v2">
      <span className="eyebrow">WELCOME BACK</span>
      <h2>Sign in to LearnPool</h2>
      <p className="muted">{demo ? 'Enter any email address and any password to try LearnPool.' : 'Use your email address and password.'}</p>
      {demo && <div className="demo-banner" role="note"><strong>Demo mode is on.</strong> Any email address and any password opens a new student account{demoInstructors ? ', or an existing student or instructor account that has not set a permanent password yet' : ', or an existing student account that has not set a permanent password yet'}. After you set a password in Settings, that password is required to sign in. Administrator accounts always need their real password.</div>}
      {message && <div className="auth-success" role="status"><CheckCircle2 size={17} /><span>{message}</span></div>}
      <form onSubmit={submit} className="form-stack auth-form-v2" noValidate>
        <label>Email address<input type="text" inputMode="email" name="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" placeholder="you@example.com" autoFocus /></label>
        <PasswordInput name="password" label="Password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" placeholder="Enter your password" required={false} />
        {error && <div className="error-box" role="alert">{error}</div>}
        <div className="forgot-password-row"><Link to="/forgot-password">Forgot password?</Link></div>
        <button className="button primary full auth-submit" disabled={busy}>{busy ? 'Please wait…' : 'Continue securely'} <ArrowRight size={16} /></button>
      </form>
      <p className="auth-foot">{demo ? 'Demo mode is for testing only and is switched off automatically in production.' : (autoDomains.length && !autoDomains.includes('*')) ? <>First time here? If your email ends in {autoDomains.join(' or ')}, sign in with your email username (the part before @) as the password. Your student account is created automatically and you will choose a new password.</> : 'Accounts are created by your LearnPool administrator, who also assigns instructor and admin access.'}</p>
    </div>
  </AuthLayout>;
}

/* ---------------------------------------------------- first-login password change */
export function ChangePasswordPage({ user, onChanged, onLogout }) {
  const navigate = useNavigate();
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async event => {
    event.preventDefault(); setError('');
    if (next.length < 8) { setError('Choose a new password with at least 8 characters.'); return; }
    if (next !== confirm) { setError('The new passwords do not match.'); return; }
    if (next === current) { setError('Your new password must be different from the current one.'); return; }
    setBusy(true);
    try {
      const { data } = await api.post('/auth/change-password', { currentPassword: current, newPassword: next, confirmPassword: confirm });
      onChanged({ ...user, ...data.user, mustChangePassword: false });
      navigate(roleHome(user.role), { replace: true });
    } catch (err) { setError(errorText(err, 'We could not update your password. Please try again.')); }
    finally { setBusy(false); }
  };
  return <AuthLayout eyebrow="SECURE ACCOUNT ACCESS">
    <section className="auth-card auth-card-v2">
      <span className="eyebrow">ONE LAST STEP</span>
      <h2>Choose a new password</h2>
      <p className="muted">Welcome, {user.name?.split(' ')[0] || 'there'}. For your security, replace the initial password your administrator gave you before you continue.</p>
      <form className="form-stack auth-form-v2" onSubmit={submit}>
        <PasswordInput name="current" label="Current (initial) password" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" placeholder="Your initial password" />
        <PasswordInput name="new" label="New password" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" />
        <PasswordInput name="confirm" label="Confirm new password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" placeholder="Enter it again" />
        <small className="field-help">Use at least 8 characters and avoid your email username.</small>
        {error && <div className="error-box" role="alert">{error}</div>}
        <button className="button primary full auth-submit" disabled={busy}>{busy ? 'Please wait…' : 'Update password and continue'} <ArrowRight size={16} /></button>
      </form>
      <p className="auth-switch"><button type="button" onClick={onLogout}>← Sign out</button></p>
    </section>
  </AuthLayout>;
}

/* ------------------------------------------------------- user management (admin) */
const statusOf = user => user.status === 'suspended' || user.status === 'disabled' ? 'inactive' : 'active';
const roleLabel = role => ({ student: 'Student', instructor: 'Instructor', admin: 'Admin' })[normalizeRole(role)] || role;

export function UsersPage({ items, onReload, setNotice, showAdd, onCloseAdd, onOpenAdd }) {
  const [search, setSearch] = useState(''), [role, setRole] = useState('all'), [status, setStatus] = useState('all'), [selected, setSelected] = useState(null);
  const users = useMemo(() => items.filter(u => u.role !== 'admin'), [items]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter(u => (!q || u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q))
      && (role === 'all' || normalizeRole(u.role) === role)
      && (status === 'all' || statusOf(u) === status));
  }, [users, search, role, status]);
  const current = selected && users.find(u => u._id === selected);

  return <section className="panel resource-panel admin-users-panel">
    <div className="resource-toolbar">
      <div><span className="eyebrow">PLATFORM ADMINISTRATION</span><h3>User Management</h3><p className="muted">Create accounts, assign Student or Instructor roles and manage access.</p></div>
      <div className="toolbar-actions"><button className="button primary" onClick={onOpenAdd}><span>＋</span> Add new user</button></div>
    </div>
    <div className="user-filters">
      <label className="user-search"><span aria-hidden="true">⌕</span><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or email" aria-label="Search users" /></label>
      <select value={role} onChange={e => setRole(e.target.value)} aria-label="Filter by role"><option value="all">All roles</option><option value="student">Students</option><option value="instructor">Instructors</option></select>
      <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status"><option value="all">Any status</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
      <span className="muted user-count">{visible.length} of {users.length}</span>
    </div>
    {visible.length ? <div className="table-wrap"><table>
      <thead><tr><th>NAME</th><th>EMAIL</th><th>ROLE</th><th>STATUS</th><th>ACTION</th></tr></thead>
      <tbody>{visible.map(user => {
        const inactive = statusOf(user) === 'inactive';
        const pending = ['faculty', 'instructor'].includes(user.role) && user.isApproved === false;
        return <tr key={user._id}>
          <td><div className="user-cell"><Avatar user={user} /><strong>{user.name}</strong></div></td>
          <td>{user.email}</td>
          <td><span className={`role-chip role-${normalizeRole(user.role)}`}>{roleLabel(user.role)}</span></td>
          <td><span className={`status-pill ${pending ? 'pending-status' : inactive ? 'suspended-status' : 'active-status'}`}>{pending ? 'Awaiting approval' : inactive ? 'Inactive' : 'Active'}</span></td>
          <td className="user-admin-actions"><button className="button outline compact-button" onClick={() => setSelected(user._id)}>Change role</button></td>
        </tr>;
      })}</tbody></table></div>
      : <div className="empty-state"><span className="empty-icon">♙</span><strong>{users.length ? 'No users match your search' : 'No users yet'}</strong><p>{users.length ? 'Try a different name, email or filter.' : 'Use “Add new user” to create the first Student or Instructor account.'}</p></div>}
    {showAdd && <AddUserModal onClose={onCloseAdd} onCreated={(name, username) => { onCloseAdd(); setNotice(`Account created for ${name}. Initial password: ${username}`); onReload(); }} />}
    {current && <UserDetailModal user={current} onClose={() => setSelected(null)} onChanged={message => { if (message) setNotice(message); onReload(); }} onDeleted={message => { setSelected(null); setNotice(message); onReload(); }} />}
  </section>;
}

function AddUserModal({ onClose, onCreated }) {
  const [name, setName] = useState(''), [email, setEmail] = useState(''), [role, setRole] = useState('student');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const cleanEmail = email.trim().toLowerCase();
  const username = cleanEmail.includes('@') ? cleanEmail.split('@')[0] : '';
  const submit = async event => {
    event.preventDefault(); setError('');
    if (name.trim().length < 2) { setError('Enter the person’s full name.'); return; }
    if (!EMAIL_FORMAT.test(cleanEmail)) { setError('Enter a valid email address.'); return; }
    setBusy(true);
    try { await api.post('/users', { name: name.trim(), email: cleanEmail, role }); onCreated(name.trim(), username); }
    catch (err) { setError(errorText(err, 'The account could not be created.')); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true" aria-label="Add new user">
    <div className="modal-heading"><div><span className="eyebrow">USER MANAGEMENT</span><h2>Add new user</h2></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div>
    <form className="form-stack modal-form" onSubmit={submit} noValidate>
      <label>Full name<input value={name} onChange={e => setName(e.target.value)} placeholder="Student One" autoFocus /></label>
      <label>Email address<input value={email} onChange={e => setEmail(e.target.value)} inputMode="email" autoComplete="off" placeholder="name@example.com" /></label>
      <label>Account role<select value={role} onChange={e => setRole(e.target.value)}><option value="student">Student</option><option value="instructor">Instructor</option></select></label>
      <label>Initial password<input value={username || ''} readOnly placeholder="Generated from the email username" /><small className="field-help">Created automatically from the part of the email before @. It is stored securely hashed, and the user must change it at first sign-in.</small></label>
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button outline" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button></div>
    </form>
  </section></div>;
}

function UserDetailModal({ user, onClose, onChanged, onDeleted }) {
  const [role, setRole] = useState(normalizeRole(user.role)), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirming, setConfirming] = useState(null);
  const inactive = statusOf(user) === 'inactive';
  const pending = ['faculty', 'instructor'].includes(user.role) && user.isApproved === false;
  const [name, setName] = useState(user.name || ''), [email, setEmail] = useState(user.email || ''), [phone, setPhone] = useState(user.phoneNumber || '');
  const detailsDirty = name !== (user.name || '') || email !== (user.email || '') || phone !== (user.phoneNumber || '');
  const close = () => { if (detailsDirty && !window.confirm('Discard your unsaved changes?')) return; onClose(); };
  const run = async (task, success) => {
    setBusy(true); setError('');
    try { await task(); setConfirming(null); onChanged(success); }
    catch (err) { setError(errorText(err, 'That action could not be completed.')); }
    finally { setBusy(false); }
  };
  const saveDetails = () => run(() => api.patch(`/users/${user._id}`, { name, email, phoneNumber: phone }), 'Details updated.');
  const saveRole = () => run(() => api.patch(`/users/${user._id}/access`, { role }), `${user.name} is now ${roleLabel(role)}.`);
  const toggleStatus = () => run(() => api.patch(`/users/${user._id}/access`, { status: inactive ? 'active' : 'suspended' }), inactive ? 'Account activated.' : 'Account deactivated.');
  const approve = () => run(() => api.put(`/users/${user._id}/approve`), `${user.name} can now teach on LearnPool.`);
  const reset = () => run(() => api.post(`/users/${user._id}/reset-password`), 'Password reset to the initial password. The user must change it at next sign-in.');
  const remove = async () => {
    setBusy(true); setError('');
    try { await api.delete(`/users/${user._id}`); onDeleted(`${user.name}’s account was deleted.`); }
    catch (err) { setError(errorText(err, 'The account could not be deleted.')); setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && close()}><section className="modal user-detail" role="dialog" aria-modal="true" aria-label="Account details">
    <div className="modal-heading"><div><span className="eyebrow">ACCOUNT DETAILS</span><h2>{user.name}</h2></div><button className="modal-close" onClick={close} aria-label="Close">×</button></div>
    <div className="user-detail-head"><Avatar user={user} className="large" /><div><strong>{user.email}</strong><span className={`status-pill ${pending ? 'pending-status' : inactive ? 'suspended-status' : 'active-status'}`}>{pending ? 'Awaiting approval' : inactive ? 'Inactive' : 'Active'}</span></div></div>
    <dl className="detail-list">
      <div><dt>Role</dt><dd>{roleLabel(user.role)}</dd></div>
      <div><dt>Created</dt><dd>{dateLabel(user.createdAt)}</dd></div>
      <div><dt>Last active</dt><dd>{dateLabel(user.lastActive)}</dd></div>
      <div><dt>Password</dt><dd>{user.passwordSetupComplete === false ? 'Not set up yet (temporary or initial password)' : 'Permanent password set'}</dd></div>
    </dl>
    <div className="detail-section details-edit"><strong className="detail-heading">Edit details</strong>
      <div className="details-grid">
        <label>Full name<input value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Email address<input value={email} onChange={e => setEmail(e.target.value)} inputMode="email" /></label>
        <label>Phone number<input value={phone} onChange={e => setPhone(e.target.value)} /></label>
      </div>
      <div className="inline-row"><button className="button primary compact-button" disabled={busy || !detailsDirty} onClick={saveDetails}>Save details</button>{detailsDirty && <button className="button outline compact-button" disabled={busy} onClick={() => { setName(user.name || ''); setEmail(user.email || ''); setPhone(user.phoneNumber || ''); }}>Cancel editing</button>}</div>
    </div>
    <div className="detail-section"><label>Change role<div className="inline-row"><select value={role} onChange={e => setRole(e.target.value)}><option value="student">Student</option><option value="instructor">Instructor</option></select><button className="button primary compact-button" disabled={busy || role === normalizeRole(user.role)} onClick={saveRole}>Save role</button></div></label></div>
    {error && <div className="error-box" role="alert">{error}</div>}
    {confirming ? <div className="confirm-box" role="alertdialog">
      <strong>{confirming === 'delete' ? `Delete ${user.name}’s account?` : `Reset ${user.name}’s password?`}</strong>
      <p>{confirming === 'delete' ? 'This permanently removes the account and cannot be undone.' : 'The password becomes the email username again and the user must choose a new one at next sign-in.'}</p>
      <div className="modal-actions"><button className="button outline compact-button" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button><button className={`button compact-button ${confirming === 'delete' ? 'danger' : 'primary'}`} disabled={busy} onClick={confirming === 'delete' ? remove : reset}>{confirming === 'delete' ? 'Yes, delete account' : 'Yes, reset password'}</button></div>
    </div> : <div className="detail-actions">
      {pending && <button className="button success compact-button" disabled={busy} onClick={approve}>Approve instructor</button>}
      <button className="button outline compact-button" disabled={busy} onClick={toggleStatus}>{inactive ? 'Activate account' : 'Deactivate account'}</button>
      <button className="button outline compact-button" disabled={busy} onClick={() => setConfirming('reset')}>Reset password</button>
      <button className="button danger compact-button" disabled={busy} onClick={() => setConfirming('delete')}>Delete account</button>
    </div>}
  </section></div>;
}

/* ------------------------------------------------------------ profile picture */
const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PICTURE_MAX = 2 * 1024 * 1024;

export function ProfilePicturePanel({ user, onUserUpdate, setNotice }) {
  const input = useRef(null);
  const [file, setFile] = useState(null), [preview, setPreview] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const choose = event => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    if (!PICTURE_TYPES.includes(picked.type)) { setError('Use a JPG, PNG or WebP image.'); return; }
    if (picked.size > PICTURE_MAX) { setError('Profile pictures must be 2 MB or smaller.'); return; }
    setError(''); setFile(picked); setPreview(URL.createObjectURL(picked));
  };
  const cancel = () => { setFile(null); setPreview(''); setError(''); };
  const save = async () => {
    setBusy(true); setError('');
    try {
      const form = new FormData(); form.append('picture', file);
      const { data } = await api.post('/users/profile/picture', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      onUserUpdate({ ...user, profilePicture: data.data.profilePicture });
      cancel(); setNotice('Profile picture saved.');
    } catch (err) { setError(errorText(err, 'Your picture could not be saved.')); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try { await api.delete('/users/profile/picture'); onUserUpdate({ ...user, profilePicture: '' }); setNotice('Profile picture removed.'); }
    catch (err) { setError(errorText(err, 'Your picture could not be removed.')); }
    finally { setBusy(false); }
  };
  return <section className="panel settings-panel picture-panel">
    <span className="eyebrow">PROFILE PICTURE</span><h3>Your photo</h3><p>JPG, PNG or WebP, up to 2 MB.</p>
    <div className="picture-row">
      <span className="avatar xlarge">{preview ? <img src={preview} alt="Preview of your new profile picture" /> : user.profilePicture ? <img src={assetUrl(user.profilePicture)} alt="Your profile picture" /> : initials(user.name)}</span>
      <div className="picture-actions">
        <input ref={input} type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={choose} hidden />
        {file ? <>
          <span className="muted">Preview — not saved yet</span>
          <div className="inline-row"><button className="button primary compact-button" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save picture'}</button><button className="button outline compact-button" disabled={busy} onClick={cancel}>Cancel</button></div>
        </> : <div className="inline-row">
          <button className="button outline compact-button" disabled={busy} onClick={() => input.current?.click()}>{user.profilePicture ? 'Change picture' : 'Upload picture'}</button>
          {user.profilePicture && <button className="button outline compact-button" disabled={busy} onClick={remove}>Remove</button>}
        </div>}
      </div>
    </div>
    {error && <div className="error-box" role="alert">{error}</div>}
  </section>;
}

export function PasswordPanel({ setNotice, mode = 'change', onSession }) {
  const setup = mode === 'set';   // an onboarding session: no permanent password exists yet
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async event => {
    event.preventDefault(); setError('');
    if (next.length < 8) { setError('Choose a new password with at least 8 characters.'); return; }
    if (next !== confirm) { setError('The new passwords do not match.'); return; }
    setBusy(true);
    try {
      if (setup) {
        const { data } = await api.post('/auth/set-password', { newPassword: next, confirmPassword: confirm });
        onSession(data.token, data.user);   // the onboarding session becomes a normal one
        setNotice(data.message || 'Your permanent password is set.');
      } else {
        await api.post('/auth/change-password', { currentPassword: current, newPassword: next, confirmPassword: confirm });
        setNotice('Your password has been updated.');
      }
      setCurrent(''); setNext(''); setConfirm('');
    } catch (err) { setError(errorText(err, 'We could not save your password.')); }
    finally { setBusy(false); }
  };
  return <form className="panel settings-panel" onSubmit={submit}>
    <span className="eyebrow">SECURITY</span>
    <h3>{setup ? 'Set Your Password' : 'Change password'}</h3>
    {setup
      ? <div className="demo-banner" role="note">You signed in with a temporary demo password, which is not a real password. Create a permanent password now; you will use it, with this email, the next time you sign in.</div>
      : <p>Change your account password securely.</p>}
    <div className="form-stack">
      {!setup && <PasswordInput name="current" label="Current password" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" />}
      <PasswordInput name="new" label={setup ? 'New Password' : 'New password'} value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" />
      <PasswordInput name="confirm" label={setup ? 'Confirm Password' : 'Confirm new password'} value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
    </div>
    {error && <div className="error-box" role="alert">{error}</div>}
    <button className="button primary" disabled={busy}>{busy ? 'Saving…' : setup ? 'Set Password' : 'Update password'}</button>
  </form>;
}
