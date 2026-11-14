import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

/* ----------------------------------------------------------------- helpers */
const pad = n => String(n).padStart(2, '0');
// ISO date -> value for <input type="datetime-local"> / <input type="date"> in the user's own time zone
export const toLocalInput = (value, kind = 'datetime-local') => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return kind === 'date' ? day : `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const apiMessage = (err, fallback) => err?.response?.data?.message || err?.message || fallback;

// Warn before leaving with unsaved edits (closing the dialog or the browser tab).
function useDirtyGuard(dirty) {
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  return () => !dirty || window.confirm('Discard your unsaved changes?');
}

/* ---------------------------------------------------------------- confirm dialog */
export function ConfirmDialog({ title, message, confirmLabel = 'Delete', danger = true, onConfirm, onCancel }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async () => {
    setBusy(true); setError('');
    try { await onConfirm(); }
    catch (err) { setError(apiMessage(err, 'That could not be completed.')); setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && !busy && onCancel()}>
    <section className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-label={title}>
      <div className="modal-heading"><div><span className="eyebrow">PLEASE CONFIRM</span><h2>{title}</h2></div></div>
      <p className="muted confirm-text">{message}</p>
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="modal-actions"><button className="button outline" disabled={busy} onClick={onCancel}>Cancel</button><button className={`button ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={run}>{busy ? 'Working…' : confirmLabel}</button></div>
    </section>
  </div>;
}

/* ------------------------------------------------------------ record form modal */
const LABELS = { courses: 'course', classes: 'class', assignments: 'assignment', announcements: 'announcement', todos: 'to-do', files: 'file details', reports: 'report', 'system-settings': 'setting' };
export const createLabel = id => ({ courses: 'New course', classes: 'Schedule class', assignments: 'Create assignment', announcements: 'New announcement', certificates: 'Issue certificate', 'system-settings': 'Add setting', enrollments: 'Enroll learner', reports: 'Add report note' })[id] || 'Create';

const FIELDS = (type, editing, canPickCourse) => {
  switch (type) {
    case 'certificates': return [['userId', 'Learner', 'user', true], ['courseId', 'Course', 'course', true], ['certificateType', 'Certificate type', 'certificateType', true]];
    case 'enrollments': return [['userId', 'Learner', 'user', true], ['courseId', 'Course', 'course', true]];
    case 'system-settings': return [['settingKey', 'Setting name', 'text', true], ['settingValue', 'Value', 'textarea', true], ['description', 'Description', 'textarea', false]];
    case 'courses': return [['title', 'Course name', 'text', true], ['description', 'Description', 'textarea', true], ['category', 'Subject area', 'text', false], ['level', 'Level', 'level', false], ['duration', 'Duration (for example, 6 weeks)', 'text', false], ['status', 'Status', 'course-status', false], ['thumbnail', 'Cover image link', 'url', false]];
    case 'classes': return [['title', 'Class title', 'text', true], ['course', 'Course', 'course', true], ['startTime', 'Date and time', 'datetime-local', true], ['endTime', 'End time', 'datetime-local', false], ['meetingLink', 'Meeting link', 'url', false], ['recordingUrl', 'Recording link', 'url', false], ['description', 'Notes for learners', 'textarea', false]];
    case 'assignments': return [['title', 'Assignment title', 'text', true], ['course', 'Course', 'course', true], ['description', 'Instructions', 'textarea', false], ['dueDate', 'Due date', 'datetime-local', false], ['maxGrade', 'Points available', 'number', false], ['status', 'Publish status', 'select-status', false]];
    case 'todos': return [['title', 'What needs doing?', 'text', true], ['description', 'Add a note', 'textarea', false], ['dueDate', 'Due date', 'date', false], ['priority', 'Priority', 'priority', false]];
    case 'announcements': return [['title', 'Announcement title', 'text', true], ['body', 'Message', 'textarea', true], ['audience', 'Share with', 'audience', true]];
    case 'reports': return [['title', 'Report title', 'text', true], ...(canPickCourse ? [['course', 'Course (optional)', 'course', false]] : []), ['description', 'Summary', 'textarea', false], ['periodStart', 'Period start', 'date', false], ['periodEnd', 'Period end', 'date', false]];
    case 'inbox': return [['recipientEmail', 'To (email)', 'email', true], ['subject', 'Subject', 'text', true], ['content', 'Message', 'textarea', true]];
    default: return editing ? [['name', 'File name', 'text', true], ['category', 'Category', 'text', false], ['description', 'Description', 'textarea', false]] : [['file', 'Choose a file', 'file', true], ['category', 'Category', 'text', false]];
  }
};

// The value a stored record holds for a form field.
const recordValue = (type, record, name) => {
  if (!record) return undefined;
  if (type === 'courses') return record[name];
  if (name === 'course') return record.course?._id || record.course || record.data?.course;
  return record.data?.[name];
};

/**
 * One form for creating AND editing records. With `record` it opens pre-filled and calls onSave with the
 * changed form; the caller decides which update endpoint to use.
 */
export function RecordModal({ type, courses = [], record, role, onClose, onSave }) {
  const editing = !!record;
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [dirty, setDirty] = useState(false);
  const confirmClose = useDirtyGuard(dirty);
  const close = () => { if (!busy && confirmClose()) onClose(); };
  const learners = typeof window !== 'undefined' ? window.__learnpoolUsers || [] : [];
  const fields = FIELDS(type, editing, ['instructor', 'admin'].includes(role));
  const courseOptions = courses.map(c => <option value={c._id} key={c._id}>{c.title}</option>);

  const submit = async event => {
    event.preventDefault();
    setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    const payload = type === 'files' && !editing ? form : Object.fromEntries(form);
    if (type === 'courses') { payload.description = payload.description || 'A new LearnPool course.'; if (!editing) { delete payload.status; } }
    if (type === 'assignments') {
      payload.maxGrade = Number(payload.maxGrade || 100);
      payload.dueDate = payload.dueDate ? new Date(payload.dueDate).toISOString() : null;
      payload.status = payload.status || 'draft';
      payload.courseName = courses.find(x => x._id === payload.course)?.title || '';
    }
    if (type === 'classes') {
      payload.startTime = payload.startTime ? new Date(payload.startTime).toISOString() : null;
      payload.endTime = payload.endTime ? new Date(payload.endTime).toISOString() : null;
      payload.courseName = courses.find(x => x._id === payload.course)?.title || '';
    }
    try { await onSave(payload); setDirty(false); }
    catch (err) { setError(err.message || 'Could not save this item.'); }
    finally { setBusy(false); }
  };

  const input = ([name, label, kind, required]) => {
    const raw = recordValue(type, record, name);
    const common = { name, required, defaultValue: kind === 'datetime-local' || kind === 'date' ? toLocalInput(raw, kind) : (raw ?? undefined) };
    if (kind === 'textarea') return <textarea {...common} rows="3" />;
    if (kind === 'course') return <select {...common} defaultValue={raw || ''}><option value="">Select a course</option>{courseOptions}</select>;
    if (kind === 'level') return <select name={name} defaultValue={raw || 'Beginner'}><option>Beginner</option><option>Intermediate</option><option>Advanced</option></select>;
    if (kind === 'course-status') return <select name={name} defaultValue={raw || 'published'}><option value="published">Published</option><option value="draft">Draft</option><option value="archived">Archived</option></select>;
    if (kind === 'select-status') return <select name={name} defaultValue={raw || 'draft'}><option value="draft">{editing ? 'Draft (hidden from learners)' : 'Save as draft'}</option><option value="published">{editing ? 'Published' : 'Publish now'}</option></select>;
    if (kind === 'priority') return <select name={name} defaultValue={raw || 'normal'}><option value="normal">normal</option><option value="high">high</option><option value="low">low</option></select>;
    if (kind === 'audience') return <select name={name} defaultValue={raw || 'all'}><option value="all">Everyone</option><option value="student">Students</option><option value="instructor">Instructors</option></select>;
    if (kind === 'user' && learners.length) return <select name={name} required={required} defaultValue=""><option value="">Select a person</option>{learners.filter(u => u.role === 'student').map(u => <option key={u._id} value={u._id}>{u.name} — {u.email}</option>)}</select>;
    return <input type={kind === 'user' || kind === 'certificateType' ? 'text' : kind} {...common} min={kind === 'number' ? 0 : undefined} />;
  };

  const heading = editing ? `Edit ${LABELS[type] || 'item'}` : createLabel(type);
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && close()}>
    <section className="modal" role="dialog" aria-modal="true" aria-label={heading}>
      <div className="modal-heading"><div><span className="eyebrow">{editing ? 'EDITING — CHANGES SAVE TO THE SAME RECORD' : 'LEARNPOOL WORKSPACE'}</span><h2>{heading}</h2></div><button className="modal-close" onClick={close} aria-label="Close">×</button></div>
      <form onSubmit={submit} onChange={() => setDirty(true)} className="form-stack modal-form">
        {fields.map(f => <label key={f[0]}>{f[1]}{input(f)}</label>)}
        {error && <div className="error-box" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="button outline" onClick={close}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Save'}</button></div>
      </form>
    </section>
  </div>;
}

/* ------------------------------------------------------------ assessment editor */
const blankQuestion = () => ({ questionText: '', options: '', correctAnswerIndex: 0, marks: 1 });
const toDraft = q => ({ _id: q._id, questionText: q.questionText || '', options: (q.options || []).join('\n'), correctAnswerIndex: q.correctAnswerIndex ?? 0, marks: q.marks ?? 1 });

// Create (POST) or edit (PUT) an assessment. Fully controlled so removing a question never mixes up answers.
export function TestEditorModal({ moduleId, test, onClose, onDone }) {
  const editing = !!test;
  const [title, setTitle] = useState(test?.title || ''), [duration, setDuration] = useState(test?.duration ?? 0);
  const [questions, setQuestions] = useState(() => test?.questions?.length ? test.questions.map(toDraft) : [blankQuestion()]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const confirmClose = useDirtyGuard(dirty);
  const close = () => { if (!busy && confirmClose()) onClose(); };
  const touch = fn => (...args) => { setDirty(true); fn(...args); };
  const update = touch((i, key, value) => setQuestions(qs => qs.map((q, n) => n === i ? { ...q, [key]: value } : q)));

  const submit = async event => {
    event.preventDefault(); setBusy(true); setError('');
    const clean = questions.map(q => {
      const options = String(q.options).split('\n').map(x => x.trim()).filter(Boolean);
      return { ...(q._id ? { _id: q._id } : {}), questionText: String(q.questionText).trim(), options, correctAnswerIndex: Number(q.correctAnswerIndex), marks: Number(q.marks || 1) };
    });
    if (!title.trim()) { setError('Give the assessment a title.'); setBusy(false); return; }
    if (clean.some(q => !q.questionText || q.options.length < 2 || q.correctAnswerIndex < 0 || q.correctAnswerIndex >= q.options.length)) { setError('Each question needs at least two options and one correct answer.'); setBusy(false); return; }
    try {
      const body = { title: title.trim(), duration: Number(duration || 0), questions: clean };
      if (editing) await api.put('/tests/' + test._id, body); else await api.post('/tests/' + moduleId, body);
      setDirty(false); onDone(editing);
    } catch (err) { setError(apiMessage(err, 'Could not save the assessment.')); }
    finally { setBusy(false); }
  };

  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && close()}><section className="modal quiz-modal" role="dialog" aria-modal="true">
    <div className="modal-heading"><div><span className="eyebrow">{editing ? 'EDITING ASSESSMENT' : 'COURSE ASSESSMENT'}</span><h2>{editing ? 'Edit assessment' : 'Create an assessment'}</h2></div><button className="modal-close" onClick={close} aria-label="Close">×</button></div>
    <form className="form-stack modal-form" onSubmit={submit}>
      {editing && <p className="muted">If learners have already attempted this assessment, questions can only be reworded so their results stay correct.</p>}
      <label>Assessment title<input value={title} onChange={e => { setDirty(true); setTitle(e.target.value); }} required /></label>
      <label>Time limit in minutes<input type="number" min="0" value={duration} onChange={e => { setDirty(true); setDuration(e.target.value); }} /><small>Set to 0 for no time limit.</small></label>
      {questions.map((q, i) => {
        const optionCount = Math.max(2, String(q.options).split('\n').filter(x => x.trim()).length);
        return <section className="question-editor" key={q._id || i}>
          <div className="question-editor-head"><strong>Question {i + 1}</strong>{questions.length > 1 && <button type="button" className="delete-button" aria-label={`Remove question ${i + 1}`} onClick={touch(() => setQuestions(qs => qs.filter((_, n) => n !== i)))}>×</button>}</div>
          <label>Question<input value={q.questionText} onChange={e => update(i, 'questionText', e.target.value)} required placeholder="Write your question" /></label>
          <label>Answer choices<textarea rows="4" value={q.options} onChange={e => update(i, 'options', e.target.value)} required placeholder={'One answer per line\nSecond answer\nThird answer'} /><small>Enter one answer choice per line.</small></label>
          <div className="question-fields">
            <label>Correct choice<select value={q.correctAnswerIndex} onChange={e => update(i, 'correctAnswerIndex', Number(e.target.value))}>{Array.from({ length: Math.max(optionCount, Number(q.correctAnswerIndex) + 1) }, (_, n) => <option value={n} key={n}>Choice {String.fromCharCode(65 + n)}</option>)}</select></label>
            <label>Points<input type="number" min="1" value={q.marks} onChange={e => update(i, 'marks', e.target.value)} /></label>
          </div>
        </section>;
      })}
      <button type="button" className="text-link" onClick={touch(() => setQuestions(qs => [...qs, blankQuestion()]))}>＋ Add question</button>
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button outline" onClick={close}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create assessment'}</button></div>
    </form>
  </section></div>;
}

/* ------------------------------------------------- small curriculum edit dialogs */
// Edit a module title, a topic, or a lesson (title, link, or a replacement upload).
export function CurriculumEditModal({ kind, record, onClose, onDone }) {
  const isLesson = kind === 'lesson', isLink = !record.fileType || record.fileType === 'external/link';
  const [title, setTitle] = useState(record.title || ''), [url, setUrl] = useState(isLesson && isLink ? record.fileUrl || '' : '');
  const [file, setFile] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const confirmClose = useDirtyGuard(dirty);
  const close = () => { if (!busy && confirmClose()) onClose(); };
  const submit = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (kind === 'module') await api.put('/modules/' + record._id, { title });
      else if (kind === 'topic') await api.put('/modules/topics/' + record._id, { title });
      else if (file) { const form = new FormData(); form.append('title', title); form.append('file', file); await api.put('/modules/lectures/' + record._id, form, { headers: { 'Content-Type': 'multipart/form-data' } }); }
      else await api.put('/modules/lectures/' + record._id, { title, ...(isLink && url ? { fileUrl: url } : {}) });
      setDirty(false); onDone();
    } catch (err) { setError(apiMessage(err, 'Could not save your changes.')); }
    finally { setBusy(false); }
  };
  const label = { module: 'module', topic: 'topic', lesson: 'lesson' }[kind];
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && close()}><section className="modal" role="dialog" aria-modal="true">
    <div className="modal-heading"><div><span className="eyebrow">COURSE CURRICULUM</span><h2>Edit {label}</h2></div><button className="modal-close" onClick={close} aria-label="Close">×</button></div>
    <form className="form-stack modal-form" onSubmit={submit}>
      <label>{label[0].toUpperCase() + label.slice(1)} title<input value={title} onChange={e => { setDirty(true); setTitle(e.target.value); }} required minLength="2" maxLength="160" /></label>
      {isLesson && isLink && <label>Resource link<input type="url" value={url} onChange={e => { setDirty(true); setUrl(e.target.value); }} placeholder="https://…" /></label>}
      {isLesson && <label>{isLink ? 'Or replace with an uploaded file' : 'Replace the uploaded file (optional)'}<input type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.png,.jpg,.jpeg,.mp4" onChange={e => { setDirty(true); setFile(e.target.files?.[0] || null); }} /></label>}
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button outline" onClick={close}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></div>
    </form>
  </section></div>;
}

/* -------------------------------------------------------------- report notes */
// Editable report notes. The automatic progress figures on the same page stay system-generated.
export function ReportNotes({ user, courses, setNotice }) {
  const [items, setItems] = useState([]), [loading, setLoading] = useState(true), [editing, setEditing] = useState(null), [creating, setCreating] = useState(false), [removing, setRemoving] = useState(null);
  const role = user.role === 'faculty' ? 'instructor' : user.role;
  const load = () => api.get('/workspace/reports').then(r => setItems(r.data.data || [])).catch(() => {}).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);
  const save = async values => {
    try {
      if (editing) await api.patch('/workspace/reports/' + editing._id, values); else await api.post('/workspace/reports', values);
      setNotice(editing ? 'Report updated.' : 'Report note added.'); setEditing(null); setCreating(false); load();
    } catch (err) { throw new Error(apiMessage(err, 'Could not save this report.')); }
  };
  const mine = item => String(item.owner) === String(user.id) || role === 'admin';
  const day = v => v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const courseTitle = id => courses.find(c => c._id === id)?.title;
  return <section className="panel report-notes">
    <div className="resource-toolbar"><div><span className="eyebrow">REPORT NOTES</span><h3>Written reports</h3><p className="muted">Add and edit your own notes. The progress figures above are calculated automatically and can’t be edited.</p></div><div className="toolbar-actions"><button className="button primary" onClick={() => setCreating(true)}>＋ {createLabel('reports')}</button></div></div>
    {loading ? <div className="loading-state"><span className="spinner" /> Loading…</div> : items.length ? <div className="record-list">{items.map(item => <article className="record-card" key={item._id}>
      <span className="record-symbol">◇</span>
      <div><strong>{item.data?.title}</strong><span>{item.data?.description || 'No summary yet'}{item.data?.periodStart ? ` · ${day(item.data.periodStart)}${item.data?.periodEnd ? ' – ' + day(item.data.periodEnd) : ''}` : ''}{item.course ? ` · ${item.data?.courseName || courseTitle(item.course) || 'Course'}` : ''}</span></div>
      {mine(item) ? <div className="table-actions"><button className="small-button" onClick={() => setEditing(item)}>Edit</button><button className="small-button danger" onClick={() => setRemoving(item)}>Delete</button></div> : <span className="status-pill subdued">From your instructor</span>}
    </article>)}</div> : <p className="muted">No report notes yet.</p>}
    {(creating || editing) && <RecordModal type="reports" courses={courses} record={editing} role={role} onClose={() => { setCreating(false); setEditing(null); }} onSave={save} />}
    {removing && <ConfirmDialog title="Delete this report?" message={`“${removing.data?.title}” will be removed permanently.`} onCancel={() => setRemoving(null)} onConfirm={async () => { await api.delete('/workspace/reports/' + removing._id); setRemoving(null); setNotice('Report deleted.'); load(); }} />}
  </section>;
}
