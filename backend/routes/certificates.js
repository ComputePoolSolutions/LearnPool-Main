const express = require('express');
const PDFDocument = require('pdfkit');
const mongoose = require('mongoose');
const LmsItem = require('../models/LmsItem');
const User = require('../models/User');
const Course = require('../models/Course');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();
const publicFields = cert => ({ valid: cert.data.status !== 'revoked' && cert.data.verificationEnabled !== false, certificateNumber: cert.data.certificateNumber, recipientName: cert.data.recipientName, courseName: cert.data.courseName, certificateType: cert.data.certificateType, issuedAt: cert.data.issuedAt, status: cert.data.status });

router.get('/verify/:certificateNumber', async (req, res, next) => {
  try {
    const cert = await LmsItem.findOne({ type: 'certificates', 'data.certificateNumber': req.params.certificateNumber }).lean();
    if (!cert) return res.status(404).json({ success: false, message: 'Certificate not found.' });
    return res.json({ success: true, data: publicFields(cert) });
  } catch (e) { next(e); }
});

router.get('/:id/download', protect, async (req, res, next) => {
  try {
    const cert = await LmsItem.findOne({ _id: req.params.id, type: 'certificates' });
    if (!cert) return res.status(404).json({ success: false, message: 'Certificate not found.' });
    if (req.user.role !== 'admin' && String(cert.owner) !== String(req.user._id)) return res.status(403).json({ success: false, message: 'You can only download your own certificate.' });
    if (cert.data.status === 'revoked') return res.status(410).json({ success: false, message: 'This certificate has been revoked.' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${cert.data.certificateNumber}.pdf"`);
    const pdf = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 55 });
    pdf.pipe(res);
    pdf.rect(25, 25, 790, 545).lineWidth(1).stroke('#879d86');
    pdf.rect(34, 34, 772, 527).lineWidth(.5).stroke('#c5b782');
    pdf.fillColor('#315a43').font('Times-Bold').fontSize(14).text('LEARNPOOL', 0, 82, { align: 'center', characterSpacing: 3 });
    pdf.fillColor('#a18b53').font('Times-Roman').fontSize(10).text('CERTIFICATE OF COMPLETION', 0, 139, { align: 'center', characterSpacing: 2 });
    pdf.fillColor('#293c30').font('Times-Roman').fontSize(36).text('Certificate', 0, 177, { align: 'center' });
    pdf.fillColor('#768077').font('Helvetica').fontSize(12).text('This is to recognise the learning and dedication of', 0, 246, { align: 'center' });
    pdf.fillColor('#315a43').font('Times-Italic').fontSize(29).text(cert.data.recipientName, 70, 277, { align: 'center', width: 680 });
    pdf.moveTo(160, 319).lineTo(665, 319).lineWidth(.6).stroke('#bcc9bc');
    pdf.fillColor('#59675d').font('Helvetica').fontSize(12).text('for completing', 0, 338, { align: 'center' });
    pdf.fillColor('#293c30').font('Times-Bold').fontSize(20).text(cert.data.courseName, 90, 365, { align: 'center', width: 640 });
    pdf.fillColor('#59675d').font('Helvetica').fontSize(10).text(`Issued ${new Date(cert.data.issuedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, 0, 415, { align: 'center' });
    pdf.fillColor('#89938b').font('Helvetica').fontSize(9).text(`Certificate ID  ${cert.data.certificateNumber}     ·     Verify at ${process.env.PUBLIC_APP_URL || 'LearnPool'}/verify/${cert.data.certificateNumber}`, 65, 513, { align: 'center', width: 700 });
    pdf.end();
  } catch (e) { next(e); }
});

router.post('/', protect, authorize('admin'), async (req, res, next) => {
  try {
    const { userId, courseId, certificateType = 'course' } = req.body;
    if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(courseId)) return res.status(400).json({ success: false, message: 'Choose a valid learner and course.' });
    if (!['course', 'training', 'internship'].includes(certificateType)) return res.status(400).json({ success: false, message: 'Choose a valid certificate type.' });
    const [learner, course] = await Promise.all([User.findById(userId).select('name enrolledCourses'), Course.findById(courseId).select('title students').populate({path:'modules',populate:[{path:'lectures'},{path:'topics',populate:'lectures'}]})]);
    if (!learner || !course) return res.status(404).json({ success: false, message: 'Learner or course not found.' });
    const enrolled = course.students.some(id => String(id) === String(userId)) || learner.enrolledCourses.some(id => String(id) === String(courseId));
    if (!enrolled) return res.status(400).json({ success: false, message: 'The learner must be enrolled before a certificate can be issued.' });
    const lectureIds=course.modules.flatMap(module=>[...(module.lectures||[]),...(module.topics||[]).flatMap(topic=>topic.lectures||[])].map(lecture=>lecture._id));
    if(!lectureIds.length)return res.status(400).json({success:false,message:'Add course lessons before issuing a completion certificate.'});
    const completedIds=await require('../models/Progress').distinct('lecture',{user:userId,lecture:{$in:lectureIds},completed:true});
    if(new Set(completedIds.map(String)).size<lectureIds.length)return res.status(400).json({success:false,message:'The learner must complete every course lesson before a certificate can be issued.'});
    const existing = await LmsItem.findOne({ type: 'certificates', owner: userId, 'data.courseId': String(courseId), 'data.certificateType': certificateType, 'data.status': 'issued' });
    if (existing) return res.status(409).json({ success: false, message: 'An active certificate already exists for this learner and course.' });
    const certificateNumber = `CPS-LP-${require('crypto').randomBytes(5).toString('hex').toUpperCase()}`;
    const item = await LmsItem.create({ type: 'certificates', owner: learner._id, data: { certificateNumber, recipientName: learner.name, courseName: course.title, courseId: String(course._id), certificateType, issuedAt: new Date(), status: 'issued', verificationEnabled: true, issuedBy: String(req.user._id) } });
    await LmsItem.create({ type: 'audit-logs', owner: req.user._id, data: { action: 'certificate.issued', entityId: String(item._id), certificateNumber } });
    res.status(201).json({ success: true, data: item });
  } catch (e) { if(e.code===11000)return res.status(409).json({success:false,message:'An active certificate already exists for this learner and course.'}); next(e); }
});

router.patch('/:id/revoke', protect, authorize('admin'), async (req, res, next) => {
  try {
    const cert = await LmsItem.findOne({ _id: req.params.id, type: 'certificates' });
    if (!cert) return res.status(404).json({ success: false, message: 'Certificate not found.' });
    cert.data.status = 'revoked';
    cert.data.revokedAt = new Date();
    cert.data.revocationReason = String(req.body.reason || '').slice(0, 300);
    await cert.save();
    await LmsItem.create({ type: 'audit-logs', owner: req.user._id, data: { action: 'certificate.revoked', entityId: String(cert._id), certificateNumber: cert.data.certificateNumber } });
    res.json({ success: true, data: cert });
  } catch (e) { next(e); }
});

module.exports = router;
