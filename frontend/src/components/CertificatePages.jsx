import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, normalizeRole } from '../api.js';

/* ------------------------------------------------------------------ helpers */
const dmy = value => { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`; };
const long = value => value ? new Date(value).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—';
const STATUS = {
  not_eligible: ['Not eligible', 'subdued'], eligible: ['Eligible', 'pending-status'], pending: ['Pending verification', 'pending-status'],
  approved: ['Approved', 'active-status'], rejected: ['Rejected', 'suspended-status'], revoked: ['Revoked', 'suspended-status'], issued: ['Valid', 'active-status'],
};
function StatusPill({ status }) { const [label, cls] = STATUS[status] || [status, 'subdued']; return <span className={`status-pill ${cls}`}>{label}</span>; }

// PDF responses come back as blobs, so a JSON error message has to be read out of the blob.
async function errorMessage(err, fallback) {
  const data = err?.response?.data;
  if (data instanceof Blob) { try { return JSON.parse(await data.text()).message || fallback; } catch { return fallback; } }
  return data?.message || fallback;
}
async function fetchPdf(cert, download) {
  const res = await api.get(`/certificates/${cert._id}/${download ? 'download' : 'pdf'}`, { responseType: 'blob' });
  return window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
}
// Open in a new tab (the window is opened first so pop-up blockers allow it).
export async function viewCertificate(cert, notify) {
  const win = window.open('about:blank', '_blank');
  try { const url = await fetchPdf(cert, false); if (win) win.location.href = url; else window.location.assign(url); }
  catch (err) { if (win) win.close(); notify(await errorMessage(err, 'The certificate could not be opened.')); }
}
export async function downloadCertificate(cert, notify) {
  try {
    const url = await fetchPdf(cert, true);
    const link = document.createElement('a');
    link.href = url; link.download = `${cert.certificateNumber}.pdf`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => window.URL.revokeObjectURL(url), 10000);
  } catch (err) { notify(await errorMessage(err, 'The certificate could not be downloaded.')); }
}

function Timeline({ history }) {
  if (!history?.length) return null;
  const label = { requested: 'Requested', approved: 'Approved', rejected: 'Rejected', issued: 'Certificate issued', revoked: 'Revoked' };
  return <ol className="cert-timeline">{history.map((h, i) => <li key={i}><strong>{label[h.action] || h.action}</strong><span>{long(h.at)}{h.by ? ` · ${h.by}` : ''}</span>{h.note ? <em>{h.note}</em> : null}</li>)}</ol>;
}

/* ------------------------------------------------------------------ page */
export function CertificatesPage({ user, setNotice }) {
  const role = normalizeRole(user.role);
  return role === 'student' ? <StudentCertificates setNotice={setNotice} /> : <ManageCertificates role={role} setNotice={setNotice} />;
}

/* ------------------------------------------------------------ student view */
function StudentCertificates({ setNotice }) {
  const [courses, setCourses] = useState([]), [certs, setCerts] = useState([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api.get('/certificates/my/status'), api.get('/certificates')]);
      setCourses(a.data.data || []); setCerts(b.data.data || []); setError('');
    } catch (err) { setError(err.response?.data?.message || 'Your certificates could not be loaded.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const request = async course => {
    setBusy(course.courseId);
    try { await api.post('/certificates/requests', { courseId: course.courseId }); setNotice('Certificate request sent to your instructor for verification.'); await load(); }
    catch (err) { setNotice(err.response?.data?.message || 'The request could not be sent.'); }
    finally { setBusy(''); }
  };

  if (loading) return <div className="loading-state"><span className="spinner" /> Loading your certificates…</div>;
  return <div className="certificates-page">
    {error && <div className="error-box" role="alert">{error}</div>}
    <section className="panel resource-panel">
      <div className="resource-toolbar"><div><span className="eyebrow">COURSE COMPLETION</span><h3>Request a certificate</h3><p className="muted">Finish every lesson in a course, then ask your instructor to verify and approve your certificate.</p></div></div>
      {courses.length ? <div className="table-wrap"><table>
        <thead><tr><th>COURSE</th><th>PROGRESS</th><th>STATUS</th><th>ACTION</th></tr></thead>
        <tbody>{courses.map(c => <tr key={c.courseId}>
          <td><strong>{c.title}</strong><div className="muted small">{c.instructorName && `Instructor: ${c.instructorName}`}</div></td>
          <td><div className="mini-progress" aria-label={`${c.percentage}% complete`}><span style={{ width: `${c.percentage}%` }} /></div><span className="muted small">{c.completedLessons} of {c.totalLessons} lessons · {c.percentage}%</span></td>
          <td><StatusPill status={c.status} />{c.status === 'rejected' && c.request?.rejectionReason && <div className="muted small reject-note">Reason: {c.request.rejectionReason}</div>}</td>
          <td>{c.canRequest ? <button className="button primary compact-button" disabled={busy === c.courseId} onClick={() => request(c)}>{busy === c.courseId ? 'Sending…' : c.status === 'rejected' ? 'Request again' : 'Request certificate'}</button>
            : c.status === 'pending' ? <span className="muted small">Waiting for your instructor</span>
            : c.status === 'approved' ? <span className="muted small">See My Certificates below</span>
            : c.status === 'revoked' ? <span className="muted small">Contact your instructor</span>
            : <span className="muted small">Finish all lessons first</span>}</td>
        </tr>)}</tbody></table></div>
        : <div className="empty-state"><span className="empty-icon">◇</span><strong>No courses yet</strong><p>Enroll in a course and finish its lessons to earn a certificate.</p></div>}
    </section>

    <section className="panel resource-panel">
      <div className="resource-toolbar"><div><span className="eyebrow">YOUR ACHIEVEMENTS</span><h3>My Certificates</h3><p className="muted">Certificates approved by your instructors. They stay here every time you sign in.</p></div></div>
      {certs.length ? <div className="table-wrap"><table>
        <thead><tr><th>COURSE NAME</th><th>CERTIFICATE ID</th><th>ISSUE DATE</th><th>ACTION</th></tr></thead>
        <tbody>{certs.map(c => <tr key={c._id}>
          <td><strong>{c.courseName}</strong></td><td><code>{c.certificateNumber}</code></td><td>{dmy(c.issuedAt)}</td>
          <td>{c.status === 'revoked' ? <StatusPill status="revoked" /> : <div className="table-actions"><button className="small-button" onClick={() => viewCertificate(c, setNotice)}>View</button><button className="small-button" onClick={() => downloadCertificate(c, setNotice)}>Download</button><Link className="small-button" to={`/verify-certificate/${c.certificateNumber}`} target="_blank">Verify ↗</Link></div>}</td>
        </tr>)}</tbody></table></div>
        : <div className="empty-state"><span className="empty-icon">◇</span><strong>No certificates yet</strong><p>Once an instructor approves your request, your certificate appears here to view and download.</p></div>}
    </section>
  </div>;
}

/* ------------------------------------------------ instructor and admin view */
function ManageCertificates({ role, setNotice }) {
  const [tab, setTab] = useState('requests'), [requests, setRequests] = useState([]), [certs, setCerts] = useState([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [filter, setFilter] = useState('all'), [search, setSearch] = useState('');
  const [reviewing, setReviewing] = useState(null), [detail, setDetail] = useState(null);
  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api.get('/certificates/requests'), api.get('/certificates')]);
      setRequests(a.data.data || []); setCerts(b.data.data || []); setError('');
    } catch (err) { setError(err.response?.data?.message || 'Certificates could not be loaded.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => setFilter('all'), [tab]);

  const q = search.trim().toLowerCase();
  const shownRequests = useMemo(() => requests.filter(r => (filter === 'all' || r.status === filter) && (!q || [r.studentName, r.studentEmail, r.courseTitle, r.certificateId].some(v => String(v || '').toLowerCase().includes(q)))), [requests, filter, q]);
  const shownCerts = useMemo(() => certs.filter(c => (filter === 'all' || c.status === filter) && (!q || [c.recipientName, c.recipientEmail, c.courseName, c.certificateNumber].some(v => String(v || '').toLowerCase().includes(q)))), [certs, filter, q]);
  const pending = requests.filter(r => r.status === 'pending').length;
  const filters = tab === 'requests' ? [['all', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']] : [['all', 'All'], ['issued', 'Valid'], ['revoked', 'Revoked']];

  if (loading) return <div className="loading-state"><span className="spinner" /> Loading certificate management…</div>;
  return <section className="panel resource-panel certificates-page">
    <div className="resource-toolbar"><div><span className="eyebrow">{role === 'admin' ? 'PLATFORM ADMINISTRATION' : 'TEACHING'}</span><h3>Certificate Management</h3><p className="muted">{role === 'admin' ? 'Review requests, search issued certificates and revoke one if needed.' : 'Verify that learners have completed your courses, then approve or reject their certificate requests.'}</p></div></div>
    {error && <div className="error-box" role="alert">{error}</div>}
    <div className="cert-tabs" role="tablist">
      <button role="tab" aria-selected={tab === 'requests'} className={tab === 'requests' ? 'active' : ''} onClick={() => setTab('requests')}>Requests{pending ? <b>{pending}</b> : null}</button>
      <button role="tab" aria-selected={tab === 'certificates'} className={tab === 'certificates' ? 'active' : ''} onClick={() => setTab('certificates')}>Issued certificates</button>
    </div>
    <div className="user-filters">
      <label className="user-search"><span aria-hidden="true">⌕</span><input value={search} onChange={e => setSearch(e.target.value)} placeholder={role === 'admin' ? 'Search by student, course or certificate ID' : 'Search by student or course'} aria-label="Search certificates" /></label>
      <select value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter by status">{filters.map(([v, l]) => <option key={v} value={v}>{l === 'All' ? 'All statuses' : l}</option>)}</select>
      <span className="muted user-count">{tab === 'requests' ? shownRequests.length : shownCerts.length} shown</span>
    </div>

    {tab === 'requests' ? (shownRequests.length ? <div className="table-wrap"><table>
      <thead><tr><th>STUDENT</th><th>COURSE</th><th>COMPLETION</th><th>COMPLETED ON</th><th>STATUS</th><th>ACTION</th></tr></thead>
      <tbody>{shownRequests.map(r => <tr key={r._id}>
        <td><strong>{r.studentName}</strong><div className="muted small">{r.studentEmail}</div></td><td>{r.courseTitle}</td><td>{r.completionPercentage}%</td><td>{dmy(r.completedAt)}</td>
        <td><StatusPill status={r.status} /></td>
        <td><button className={`button compact-button ${r.status === 'pending' ? 'primary' : 'outline'}`} onClick={() => setReviewing(r._id)}>{r.status === 'pending' ? 'Review' : 'View'}</button></td>
      </tr>)}</tbody></table></div>
      : <div className="empty-state"><span className="empty-icon">◇</span><strong>{requests.length ? 'No requests match' : 'No certificate requests yet'}</strong><p>{requests.length ? 'Try a different search or status.' : 'When a learner finishes a course and asks for a certificate, it will appear here.'}</p></div>)
      : (shownCerts.length ? <div className="table-wrap"><table>
        <thead><tr><th>CERTIFICATE ID</th><th>STUDENT</th><th>COURSE</th><th>ISSUED</th><th>STATUS</th><th>ACTION</th></tr></thead>
        <tbody>{shownCerts.map(c => <tr key={c._id}>
          <td><code>{c.certificateNumber}</code></td><td><strong>{c.recipientName}</strong><div className="muted small">{c.recipientEmail}</div></td><td>{c.courseName}</td><td>{dmy(c.issuedAt)}</td>
          <td><StatusPill status={c.status === 'revoked' ? 'revoked' : 'issued'} /></td>
          <td><div className="table-actions"><button className="small-button" onClick={() => setDetail(c._id)}>Details</button>{c.status !== 'revoked' && <button className="small-button" onClick={() => viewCertificate(c, setNotice)}>View</button>}</div></td>
        </tr>)}</tbody></table></div>
        : <div className="empty-state"><span className="empty-icon">◇</span><strong>{certs.length ? 'No certificates match' : 'No certificates issued yet'}</strong><p>{certs.length ? 'Try a different search or status.' : 'Approved requests turn into certificates automatically.'}</p></div>)}

    {reviewing && <ReviewModal id={reviewing} role={role} setNotice={setNotice} onClose={() => setReviewing(null)} onChanged={() => { setReviewing(null); load(); }} onOpenCertificate={id => { setReviewing(null); setTab('certificates'); setDetail(id); }} />}
    {detail && <CertificateDetailModal id={detail} role={role} setNotice={setNotice} onClose={() => setDetail(null)} onChanged={() => { load(); }} />}
  </section>;
}

/* -------------------------------------------------------- review a request */
function ReviewModal({ id, role, setNotice, onClose, onChanged, onOpenCertificate }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [remarks, setRemarks] = useState(''), [reason, setReason] = useState('');
  useEffect(() => { api.get(`/certificates/requests/${id}`).then(r => setData(r.data.data)).catch(err => setError(err.response?.data?.message || 'This request could not be loaded.')); }, [id]);
  const decide = async action => {
    setError('');
    if (action === 'reject' && reason.trim().length < 3) { setError('Please give a reason before rejecting this request.'); return; }
    setBusy(true);
    try {
      const { data: res } = await api.patch(`/certificates/requests/${id}/${action}`, action === 'approve' ? { remarks } : { reason, remarks });
      setNotice(action === 'approve' ? res.message || 'Certificate approved and issued.' : 'Request rejected. The learner has been notified.');
      onChanged();
    } catch (err) { setError(err.response?.data?.message || 'That action could not be completed.'); setBusy(false); }
  };
  const v = data?.verification;
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && !busy && onClose()}><section className="modal review-modal" role="dialog" aria-modal="true" aria-label="Review certificate request">
    <div className="modal-heading"><div><span className="eyebrow">CERTIFICATE VERIFICATION</span><h2>{data ? `${data.studentName} · ${data.courseTitle}` : 'Review request'}</h2></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div>
    {!data && !error && <div className="loading-state"><span className="spinner" /> Loading…</div>}
    {error && <div className="error-box" role="alert">{error}</div>}
    {data && <>
      <dl className="detail-list">
        <div><dt>Student</dt><dd>{data.studentName}</dd></div><div><dt>Email</dt><dd>{data.studentEmail}</dd></div>
        <div><dt>Course</dt><dd>{data.courseTitle}</dd></div><div><dt>Instructor</dt><dd>{data.instructorName || '—'}</dd></div>
        <div><dt>Requested</dt><dd>{dmy(data.requestedAt)}</dd></div><div><dt>Status</dt><dd><StatusPill status={data.status} /></dd></div>
        <div><dt>Completion</dt><dd>{v ? `${v.percentage}% (${v.completedLessons} of ${v.totalLessons} lessons)` : `${data.completionPercentage}%`}</dd></div><div><dt>Completed on</dt><dd>{dmy(v?.completedAt || data.completedAt)}</dd></div>
      </dl>
      {v && <div className="verify-lessons"><strong className="detail-heading">Verify the learner’s completion</strong>
        {!v.finished && <div className="error-box">This learner has completed {v.completedLessons} of {v.totalLessons} lessons right now, so the certificate can’t be approved yet.</div>}
        <ul>{v.lessons.map(l => <li key={l.id} className={l.completed ? 'done' : 'todo'}><span aria-hidden="true">{l.completed ? '✓' : '○'}</span>{l.title}<small>{l.completed ? dmy(l.completedAt) : 'Not completed'}</small></li>)}</ul></div>}
      {data.status === 'pending' ? <div className="form-stack">
        <label>Remarks (optional)<textarea rows="2" value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="Anything the learner or administrators should know" /></label>
        <label>Reason for rejecting (needed only to reject)<input value={reason} onChange={e => setReason(e.target.value)} placeholder="For example: assignments are still missing" /></label>
        <div className="modal-actions"><button className="button danger" disabled={busy} onClick={() => decide('reject')}>Reject request</button><button className="button primary" disabled={busy || (v && !v.finished)} onClick={() => decide('approve')}>{busy ? 'Working…' : 'Approve certificate'}</button></div>
      </div> : <div className="decision-box">
        <strong>{data.status === 'approved' ? 'Approved' : 'Rejected'}{data.reviewedByName ? ` by ${data.reviewedByName}` : ''} on {dmy(data.reviewedAt)}</strong>
        {data.rejectionReason && <p>Reason: {data.rejectionReason}</p>}{data.remarks && <p>Remarks: {data.remarks}</p>}
        {data.certificateId && <div className="inline-row"><code>{data.certificateId}</code>{data.certificateRecordId && <button className="small-button" onClick={() => viewCertificate({ _id: data.certificateRecordId, certificateNumber: data.certificateId }, setNotice)}>View PDF</button>}{role === 'admin' && data.certificateRecordId && <button className="small-button" onClick={() => onOpenCertificate(data.certificateRecordId)}>Certificate details</button>}</div>}
      </div>}
      <Timeline history={data.history} />
    </>}
  </section></div>;
}

/* ------------------------------------------- certificate details and revoke */
function CertificateDetailModal({ id, role, setNotice, onClose, onChanged }) {
  const [cert, setCert] = useState(null), [error, setError] = useState(''), [reason, setReason] = useState(''), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get(`/certificates/${id}`).then(r => setCert(r.data.data)).catch(err => setError(err.response?.data?.message || 'This certificate could not be loaded.')), [id]);
  useEffect(() => { load(); }, [load]);
  const revoke = async () => {
    setError('');
    if (reason.trim().length < 3) { setError('Please give a reason for revoking this certificate.'); return; }
    setBusy(true);
    try { await api.patch(`/certificates/${id}/revoke`, { reason }); setNotice('Certificate revoked. It now shows as invalid on the verification page.'); setConfirm(false); setReason(''); await load(); onChanged(); }
    catch (err) { setError(err.response?.data?.message || 'The certificate could not be revoked.'); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && !busy && onClose()}><section className="modal review-modal" role="dialog" aria-modal="true" aria-label="Certificate details">
    <div className="modal-heading"><div><span className="eyebrow">CERTIFICATE DETAILS</span><h2>{cert ? cert.certificateNumber : 'Certificate'}</h2></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div>
    {!cert && !error && <div className="loading-state"><span className="spinner" /> Loading…</div>}
    {error && <div className="error-box" role="alert">{error}</div>}
    {cert && <>
      <dl className="detail-list">
        <div><dt>Student</dt><dd>{cert.recipientName}</dd></div><div><dt>Email</dt><dd>{cert.recipientEmail || '—'}</dd></div>
        <div><dt>Course</dt><dd>{cert.courseName}</dd></div><div><dt>Instructor</dt><dd>{cert.instructorName || '—'}</dd></div>
        <div><dt>Completed</dt><dd>{dmy(cert.completedAt)}</dd></div><div><dt>Issued</dt><dd>{dmy(cert.issuedAt)}</dd></div>
        <div><dt>Approved by</dt><dd>{cert.approvedByName || '—'}</dd></div><div><dt>Status</dt><dd><StatusPill status={cert.status === 'revoked' ? 'revoked' : 'issued'} /></dd></div>
      </dl>
      {cert.status === 'revoked' && <div className="decision-box"><strong>Revoked on {dmy(cert.revokedAt)}</strong><p>Reason: {cert.revocationReason}</p></div>}
      <strong className="detail-heading">History</strong><Timeline history={cert.history} />
      <div className="detail-actions">
        {cert.status !== 'revoked' && <><button className="button outline compact-button" onClick={() => viewCertificate(cert, setNotice)}>View PDF</button><button className="button outline compact-button" onClick={() => downloadCertificate(cert, setNotice)}>Download</button></>}
        <Link className="button outline compact-button" to={`/verify-certificate/${cert.certificateNumber}`} target="_blank">Open verification page ↗</Link>
      </div>
      {role === 'admin' && cert.status !== 'revoked' && (confirm
        ? <div className="confirm-box"><strong>Revoke this certificate?</strong><p>It will show as Revoked on the public verification page and can no longer be downloaded.</p>
            <label className="form-stack">Reason (required)<input value={reason} onChange={e => setReason(e.target.value)} placeholder="For example: issued in error" /></label>
            <div className="modal-actions"><button className="button outline compact-button" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button><button className="button danger compact-button" disabled={busy} onClick={revoke}>{busy ? 'Revoking…' : 'Yes, revoke'}</button></div></div>
        : <div className="detail-actions"><button className="button danger compact-button" onClick={() => setConfirm(true)}>Revoke certificate</button></div>)}
    </>}
  </section></div>;
}

/* ------------------------------------------------------ public verification */
export function VerifyPage() {
  const { certificateId = '' } = useParams();
  const [result, setResult] = useState(null);
  useEffect(() => {
    setResult(null);
    api.get(`/certificates/verify/${encodeURIComponent(certificateId)}`).then(r => setResult(r.data.data)).catch(() => setResult({ notFound: true }));
  }, [certificateId]);
  const state = result === null ? 'loading' : result.notFound ? 'missing' : result.valid ? 'valid' : 'revoked';
  const title = { loading: 'Verifying certificate…', missing: 'Certificate not found', valid: 'Certificate verified', revoked: 'Certificate revoked' }[state];
  const note = { loading: '', missing: 'We couldn’t find a certificate with this ID. Check the ID and try again.', valid: 'This certificate was issued by LearnPool after the course instructor verified completion, and it is currently valid.', revoked: 'This certificate has been revoked and is no longer valid.' }[state];
  return <main className="verify-shell"><Link className="brand" to="/login"><span className="brand-mark">l</span>LearnPool</Link>
    <section className="certificate-verify"><span className={`verify-mark ${state === 'valid' ? 'valid' : ''}`}>{state === 'valid' ? '✓' : state === 'revoked' ? '✕' : '◇'}</span>
      <span className="eyebrow">LEARNPOOL CREDENTIALS</span><h1>{title}</h1><p>{note}</p>
      {(state === 'valid' || state === 'revoked') && <div className="verify-details">
        <div><span>VALIDITY</span><strong>{state === 'valid' ? 'Valid' : 'Revoked'}</strong></div>
        <div><span>CERTIFICATE ID</span><strong>{result.certificateNumber}</strong></div>
        <div><span>STUDENT</span><strong>{result.recipientName}</strong></div>
        <div><span>COURSE</span><strong>{result.courseName}</strong></div>
        {result.instructorName && <div><span>INSTRUCTOR</span><strong>{result.instructorName}</strong></div>}
        <div><span>ISSUE DATE</span><strong>{long(result.issuedAt)}</strong></div>
        <div><span>STATUS</span><strong>{state === 'valid' ? 'Issued' : 'Revoked'}</strong></div>
      </div>}
      <Link to="/login" className="text-link">Return to LearnPool →</Link></section></main>;
}
