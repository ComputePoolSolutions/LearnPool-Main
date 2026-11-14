const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const LmsItem = require('../models/LmsItem');
const User = require('../models/User');
const Course = require('../models/Course');
const { protect } = require('../middleware/auth');
const audit = require('../utils/audit');
const { loadCourseWithLessons, completionFor } = require('../utils/courseProgress');
const { generateCertificateFile, fileFor } = require('../utils/certificatePdf');

const router = express.Router();

/* ------------------------------------------------------------------ helpers */
const roleOf = user => (user.role === 'faculty' ? 'instructor' : user.role);
const idOf = value => String(value && value._id ? value._id : value);
const text = (value, max) => String(value || '').trim().slice(0, max);
const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });
const sendError = (res, error, next) => (error && error.expose ? res.status(error.status).json({ success: false, message: error.message }) : next(error));
const needRole = (req, ...roles) => { if (!roles.includes(roleOf(req.user))) throw httpError(403, 'You do not have access to this action.'); };
// Only the course's own instructor or an admin may review its certificate requests.
const canReview = (user, course) => roleOf(user) === 'admin' || (roleOf(user) === 'instructor' && idOf(course.faculty) === idOf(user._id));
const notify = (owner, title, message, entityId) => LmsItem.create({ type: 'notifications', owner, data: { type: 'certificate', title, message, entityId: String(entityId) } }).catch(() => {});
const flat = item => { const o = typeof item.toObject === 'function' ? item.toObject() : item; return { ...(o.data || {}), _id: String(o._id), owner: o.owner, course: o.course, createdAt: o.createdAt, updatedAt: o.updatedAt }; };

// Run `fn` while holding a short-lived lock (so two requests cannot do the same thing at once).
async function withLock(name, fn, { tries = 1, delay = 120 } = {}) {
  let release = null;
  for (let i = 0; i < tries && !release; i++) {
    release = await db.acquireLock(name);
    if (!release && i < tries - 1) await new Promise(resolve => setTimeout(resolve, delay));
  }
  if (!release) throw httpError(409, 'This is already being processed. Please try again in a moment.');
  try { return await fn(); } finally { await release(); }
}

// Sequential ids such as LP-2026-001 (call this inside the "certnumber" lock).
async function nextCertificateNumber() {
  const prefix = `LP-${new Date().getFullYear()}-`;
  const rows = await LmsItem.find({ type: 'certificates', 'data.certificateNumber': { $regex: `^${prefix}` } }).lean();
  const highest = rows.reduce((max, r) => Math.max(max, Number(String(r.data.certificateNumber).slice(prefix.length)) || 0), 0);
  return `${prefix}${String(highest + 1).padStart(3, '0')}`;
}

// What anyone may see on the public verification page (no email address or other personal data).
const publicFields = cert => {
  const d = cert.data || {};
  const revoked = d.status === 'revoked';
  return {
    valid: !revoked && d.verificationEnabled !== false,
    status: revoked ? 'revoked' : 'valid',
    certificateNumber: d.certificateNumber,
    recipientName: d.recipientName,
    courseName: d.courseName,
    instructorName: d.instructorName || null,
    issuedAt: d.issuedAt,
    revokedAt: revoked ? d.revokedAt : undefined,
  };
};

/* ------------------------------------------------------- public verification */
router.get('/verify/:certificateNumber', async (req, res, next) => {
  try {
    const cert = await LmsItem.findOne({ type: 'certificates', 'data.certificateNumber': req.params.certificateNumber }).lean();
    if (!cert) return res.status(404).json({ success: false, message: 'Certificate not found.' });
    return res.json({ success: true, data: publicFields(cert) });
  } catch (e) { next(e); }
});

/* ------------------------------------------------- student: course eligibility */
router.get('/my/status', protect, async (req, res, next) => {
  try {
    needRole(req, 'student');
    const me = req.user;
    const [courses, requests, certs] = await Promise.all([
      Course.find({ students: String(me._id) }).select('_id status'),
      LmsItem.find({ type: 'certificate-requests', owner: String(me._id) }).sort({ createdAt: -1 }).lean(),
      LmsItem.find({ type: 'certificates', owner: String(me._id) }).sort({ createdAt: -1 }).lean(),
    ]);
    const out = [];
    for (const { _id, status } of courses) {
      const courseId = String(_id);
      const cert = certs.find(c => c.data.courseId === courseId);
      if (status === 'archived' && !cert) continue;
      const course = await loadCourseWithLessons(courseId);
      if (!course) continue;
      const done = await completionFor(me._id, course);
      const lastRequest = requests.find(r => r.data.courseId === courseId);
      let state = done.finished ? 'eligible' : 'not_eligible';
      if (lastRequest && lastRequest.data.status === 'pending') state = 'pending';
      else if (lastRequest && lastRequest.data.status === 'rejected' && done.finished) state = 'rejected';
      if (cert) state = cert.data.status === 'revoked' ? 'revoked' : 'approved';
      out.push({
        courseId, title: course.title, instructorName: course.faculty?.name || '', percentage: done.percentage,
        completedLessons: done.completed, totalLessons: done.total, completedAt: done.completedAt,
        status: state, canRequest: state === 'eligible' || state === 'rejected',
        request: lastRequest ? flat(lastRequest) : null,
        certificate: cert ? { _id: String(cert._id), certificateNumber: cert.data.certificateNumber, issuedAt: cert.data.issuedAt, status: cert.data.status } : null,
      });
    }
    res.json({ success: true, data: out });
  } catch (e) { sendError(res, e, next); }
});

/* ------------------------------------------------------- certificate requests */
router.post('/requests', protect, async (req, res, next) => {
  try {
    needRole(req, 'student');
    const me = req.user;
    const courseId = req.body.courseId;
    if (!db.isValidObjectId(courseId)) throw httpError(400, 'Choose a valid course.');
    const course = await loadCourseWithLessons(courseId);
    if (!course) throw httpError(404, 'Course not found.');
    if (!course.students.some(id => idOf(id) === idOf(me._id))) throw httpError(403, 'You can only request a certificate for a course you are enrolled in.');
    const done = await completionFor(me._id, course);
    if (!done.total) throw httpError(400, 'This course has no lessons yet, so a completion certificate is not available.');
    if (!done.finished) throw httpError(400, `Complete every lesson first (${done.completed} of ${done.total} done).`);

    const created = await withLock(`certreq:${me._id}:${course._id}`, async () => {
      const cert = await LmsItem.findOne({ type: 'certificates', owner: String(me._id), 'data.courseId': String(course._id) });
      if (cert) throw httpError(409, cert.data.status === 'revoked' ? 'This certificate was revoked. Please contact your instructor or administrator.' : 'You already have a certificate for this course.');
      const open = await LmsItem.findOne({ type: 'certificate-requests', owner: String(me._id), course: String(course._id), 'data.status': 'pending' });
      if (open) throw httpError(409, 'You already have a pending certificate request for this course.');
      const now = new Date();
      return LmsItem.create({
        type: 'certificate-requests', owner: me._id, course: course._id,
        data: {
          studentId: String(me._id), studentName: me.name, studentEmail: me.email, courseId: String(course._id), courseTitle: course.title,
          instructorId: idOf(course.faculty), instructorName: course.faculty?.name || '', completionPercentage: done.percentage, completedAt: done.completedAt,
          requestedAt: now, status: 'pending', remarks: '', rejectionReason: '', history: [{ at: now, action: 'requested', by: me.name, note: '' }],
        },
      });
    });
    await notify(idOf(course.faculty), 'New certificate request', `${me.name} completed ${course.title} and asked for a certificate.`, created._id);
    await audit(me, { action: 'certificate.requested', entityId: String(created._id), courseId: String(course._id) });
    res.status(201).json({ success: true, message: 'Certificate request sent for verification.', data: flat(created) });
  } catch (e) { sendError(res, e, next); }
});

router.get('/requests', protect, async (req, res, next) => {
  try {
    const role = roleOf(req.user);
    let rows;
    if (role === 'student') rows = await LmsItem.find({ type: 'certificate-requests', owner: String(req.user._id) }).sort({ createdAt: -1 }).lean();
    else if (role === 'instructor') {
      const mine = await Course.find({ faculty: String(req.user._id) }).select('_id');
      rows = mine.length ? await LmsItem.find({ type: 'certificate-requests', course: { $in: mine.map(c => String(c._id)) } }).sort({ createdAt: -1 }).lean() : [];
    } else if (role === 'admin') rows = await LmsItem.find({ type: 'certificate-requests' }).sort({ createdAt: -1 }).lean();
    else throw httpError(403, 'You do not have access to this page.');
    const status = text(req.query.status, 20), q = text(req.query.q, 100).toLowerCase();
    let data = rows.map(flat);
    if (status) data = data.filter(r => r.status === status);
    if (q) data = data.filter(r => [r.studentName, r.studentEmail, r.courseTitle, r.certificateId].some(v => String(v || '').toLowerCase().includes(q)));
    res.json({ success: true, data });
  } catch (e) { sendError(res, e, next); }
});

router.get('/requests/:id', protect, async (req, res, next) => {
  try {
    const item = await LmsItem.findOne({ _id: req.params.id, type: 'certificate-requests' });
    if (!item) throw httpError(404, 'Request not found.');
    const course = await loadCourseWithLessons(item.course);
    const isOwner = idOf(item.owner) === idOf(req.user._id);
    if (!isOwner && !(course && canReview(req.user, course))) throw httpError(403, 'You do not have access to this request.');
    const out = flat(item);
    if (!isOwner && course) {
      const done = await completionFor(item.owner, course);
      out.verification = { percentage: done.percentage, completedLessons: done.completed, totalLessons: done.total, completedAt: done.completedAt, finished: done.finished, lessons: done.lessons };
    }
    res.json({ success: true, data: out });
  } catch (e) { sendError(res, e, next); }
});

router.patch('/requests/:id/approve', protect, async (req, res, next) => {
  let savedFile = null;
  try {
    const item = await LmsItem.findOne({ _id: req.params.id, type: 'certificate-requests' });
    if (!item) throw httpError(404, 'Request not found.');
    const course = await loadCourseWithLessons(item.course);
    if (!course) throw httpError(404, 'Course not found.');
    if (!canReview(req.user, course)) throw httpError(403, 'Only this course\u2019s instructor or an administrator can approve certificates.');
    const student = await User.findById(item.owner);
    if (!student) throw httpError(404, 'Learner not found.');
    const remarks = text(req.body.remarks, 1000);

    const result = await withLock(`certissue:${student._id}:${course._id}`, async () => {
      const fresh = await LmsItem.findOne({ _id: item._id });
      if (fresh.data.status !== 'pending') throw httpError(409, `This request has already been ${fresh.data.status}.`);
      // Verify completion again, right now, from the learner's real progress.
      const done = await completionFor(student._id, course);
      if (!done.finished) throw httpError(409, `${student.name} has completed ${done.completed} of ${done.total} lessons, so this certificate cannot be approved yet.`);
      const existing = await LmsItem.findOne({ type: 'certificates', owner: String(student._id), 'data.courseId': String(course._id), 'data.status': 'issued' });
      if (existing) throw httpError(409, 'An active certificate already exists for this learner and course.');

      const now = new Date();
      const cert = await withLock('certnumber', async () => {
        const certificateNumber = await nextCertificateNumber();
        const data = {
          certificateNumber, recipientName: student.name, courseName: course.title, courseId: String(course._id),
          instructorId: idOf(course.faculty), instructorName: course.faculty?.name || 'LearnPool Instructor', certificateType: 'course',
          completionPercentage: done.percentage, completedAt: done.completedAt, issuedAt: now, status: 'issued', verificationEnabled: true,
          issuedBy: String(req.user._id), approvedByName: req.user.name, requestId: String(fresh._id),
          history: [{ at: now, action: 'issued', by: req.user.name, note: remarks || 'Approved after instructor verification' }],
        };
        const { file } = await generateCertificateFile(data);   // the real PDF is saved before the record exists
        savedFile = file;
        data.pdfFile = path.basename(file);
        return LmsItem.create({ type: 'certificates', owner: student._id, course: course._id, data });
      }, { tries: 60, delay: 100 });

      fresh.data = {
        ...fresh.data, status: 'approved', remarks, reviewedAt: now, reviewedBy: String(req.user._id), reviewedByName: req.user.name,
        certificateId: cert.data.certificateNumber, certificateRecordId: String(cert._id),
        history: [...(fresh.data.history || []), { at: now, action: 'approved', by: req.user.name, note: remarks }],
      };
      fresh.updatedBy = req.user._id;
      await fresh.save();
      return { cert, request: fresh };
    });

    await notify(student._id, 'Your certificate is ready', `Your certificate for ${course.title} has been approved. You can download it now.`, result.cert._id);
    await audit(req.user, { action: 'certificate.approved', entityId: String(result.cert._id), certificateNumber: result.cert.data.certificateNumber });
    res.json({ success: true, message: `Certificate ${result.cert.data.certificateNumber} issued.`, data: { request: flat(result.request), certificate: flat(result.cert) } });
  } catch (e) {
    if (e.code === 11000) e = httpError(409, 'An active certificate already exists for this learner and course.');
    if (savedFile && e.expose) { try { fs.unlinkSync(savedFile); } catch { /* nothing to clean up */ } }
    sendError(res, e, next);
  }
});

router.patch('/requests/:id/reject', protect, async (req, res, next) => {
  try {
    const item = await LmsItem.findOne({ _id: req.params.id, type: 'certificate-requests' });
    if (!item) throw httpError(404, 'Request not found.');
    const course = await loadCourseWithLessons(item.course);
    if (!course) throw httpError(404, 'Course not found.');
    if (!canReview(req.user, course)) throw httpError(403, 'Only this course\u2019s instructor or an administrator can review certificates.');
    const reason = text(req.body.reason, 500), remarks = text(req.body.remarks, 1000);
    if (reason.length < 3) throw httpError(400, 'Please give a reason for rejecting this request.');
    if (item.data.status !== 'pending') throw httpError(409, `This request has already been ${item.data.status}.`);
    const now = new Date();
    item.data = { ...item.data, status: 'rejected', rejectionReason: reason, remarks, reviewedAt: now, reviewedBy: String(req.user._id), reviewedByName: req.user.name, history: [...(item.data.history || []), { at: now, action: 'rejected', by: req.user.name, note: reason }] };
    item.updatedBy = req.user._id;
    await item.save();
    await notify(item.owner, 'Certificate request not approved', `Your request for ${course.title} was not approved: ${reason}`, item._id);
    await audit(req.user, { action: 'certificate.rejected', entityId: String(item._id) });
    res.json({ success: true, message: 'Request rejected.', data: flat(item) });
  } catch (e) { sendError(res, e, next); }
});

/* ----------------------------------------------------------- issued certificates */
router.get('/', protect, async (req, res, next) => {
  try {
    const role = roleOf(req.user);
    let rows;
    if (role === 'student') rows = await LmsItem.find({ type: 'certificates', owner: String(req.user._id) }).sort({ createdAt: -1 }).lean();
    else if (role === 'instructor') rows = await LmsItem.find({ type: 'certificates', 'data.instructorId': String(req.user._id) }).sort({ createdAt: -1 }).lean();
    else if (role === 'admin') rows = await LmsItem.find({ type: 'certificates' }).sort({ createdAt: -1 }).lean();
    else throw httpError(403, 'You do not have access to this page.');
    const people = rows.length ? await User.find({ _id: { $in: [...new Set(rows.map(r => idOf(r.owner)))] } }).select('name email').lean() : [];
    const byId = new Map(people.map(u => [String(u._id), u]));
    const status = text(req.query.status, 20), q = text(req.query.q, 100).toLowerCase();
    let data = rows.map(r => ({ ...flat(r), recipientEmail: role === 'student' ? undefined : byId.get(idOf(r.owner))?.email }));
    if (status) data = data.filter(c => c.status === status);
    if (q) data = data.filter(c => [c.recipientName, c.recipientEmail, c.courseName, c.certificateNumber].some(v => String(v || '').toLowerCase().includes(q)));
    res.json({ success: true, data });
  } catch (e) { sendError(res, e, next); }
});

// Certificates are issued automatically after instructor approval; manual issuing is closed.
router.post('/', protect, (req, res) => res.status(410).json({ success: false, message: 'Certificates are issued automatically after the course instructor approves a learner\u2019s request.' }));

async function sendPdf(req, res, next, forceDownload) {
  try {
    const cert = await LmsItem.findOne({ _id: req.params.id, type: 'certificates' });
    if (!cert) throw httpError(404, 'Certificate not found.');
    const d = cert.data, me = req.user;
    const allowed = roleOf(me) === 'admin' || idOf(cert.owner) === idOf(me._id) || (roleOf(me) === 'instructor' && String(d.instructorId) === idOf(me._id));
    if (!allowed) throw httpError(403, 'You can only open your own certificates.');
    if (d.status === 'revoked') throw httpError(410, 'This certificate has been revoked.');
    let buffer;
    try { buffer = fs.readFileSync(fileFor(d.certificateNumber)); }
    catch {
      // an older certificate, or the file went missing: rebuild it from the stored record
      ({ buffer } = await generateCertificateFile(d));
      if (!d.pdfFile) { cert.data = { ...d, pdfFile: `${d.certificateNumber}.pdf` }; await cert.save().catch(() => {}); }
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${forceDownload ? 'attachment' : 'inline'}; filename="${d.certificateNumber}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  } catch (e) { sendError(res, e, next); }
}
router.get('/:id/download', protect, (req, res, next) => sendPdf(req, res, next, true));
router.get('/:id/pdf', protect, (req, res, next) => sendPdf(req, res, next, req.query.download === '1'));

router.patch('/:id/revoke', protect, async (req, res, next) => {
  try {
    needRole(req, 'admin');
    const cert = await LmsItem.findOne({ _id: req.params.id, type: 'certificates' });
    if (!cert) throw httpError(404, 'Certificate not found.');
    const reason = text(req.body.reason, 300);
    if (reason.length < 3) throw httpError(400, 'Please give a reason for revoking this certificate.');
    if (cert.data.status === 'revoked') throw httpError(409, 'This certificate has already been revoked.');
    const now = new Date();
    cert.data = { ...cert.data, status: 'revoked', revokedAt: now, revokedBy: String(req.user._id), revocationReason: reason, history: [...(cert.data.history || []), { at: now, action: 'revoked', by: req.user.name, note: reason }] };
    cert.updatedBy = req.user._id;
    await cert.save();
    if (cert.data.requestId) {
      const request = await LmsItem.findOne({ _id: cert.data.requestId, type: 'certificate-requests' });
      if (request) { request.data = { ...request.data, history: [...(request.data.history || []), { at: now, action: 'revoked', by: req.user.name, note: reason }] }; await request.save(); }
    }
    await notify(cert.owner, 'Certificate revoked', `Your certificate ${cert.data.certificateNumber} was revoked: ${reason}`, cert._id);
    await audit(req.user, { action: 'certificate.revoked', entityId: String(cert._id), certificateNumber: cert.data.certificateNumber });
    res.json({ success: true, message: 'Certificate revoked.', data: flat(cert) });
  } catch (e) { sendError(res, e, next); }
});

router.get('/:id', protect, async (req, res, next) => {
  try {
    const cert = await LmsItem.findOne({ _id: req.params.id, type: 'certificates' });
    if (!cert) throw httpError(404, 'Certificate not found.');
    const me = req.user, d = cert.data;
    const allowed = roleOf(me) === 'admin' || idOf(cert.owner) === idOf(me._id) || (roleOf(me) === 'instructor' && String(d.instructorId) === idOf(me._id));
    if (!allowed) throw httpError(403, 'You do not have access to this certificate.');
    const owner = await User.findById(cert.owner).select('name email');
    res.json({ success: true, data: { ...flat(cert), recipientEmail: roleOf(me) === 'student' ? undefined : owner?.email } });
  } catch (e) { sendError(res, e, next); }
});

module.exports = router;
