'use strict';
/**
 * Offline smoke test for the Firestore data layer (no Firebase project needed).
 * Run with:  npm test
 */
const assert = require('assert');
const db = require('../db');
const memory = require('./memoryStore').create();
db.useStore(memory);

const User = require('../models/User');
const Course = require('../models/Course');
const Module = require('../models/Module');
const Lecture = require('../models/Lecture');
const Topic = require('../models/Topic');
const Test = require('../models/Test');
const Result = require('../models/Result');
const Progress = require('../models/Progress');
const Discussion = require('../models/Discussion');
const LmsItem = require('../models/LmsItem');
const LiveSession = require('../models/LiveSession');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const rejects = async (fn, check) => {
  let err;
  try { await fn(); } catch (e) { err = e; }
  assert(err, 'expected the call to fail');
  if (check) check(err);
  return err;
};

let teacher, student, course;

test('create applies defaults, lowercases email and assigns an id', async () => {
  teacher = await User.create({ name: 'Ada Teacher', email: 'ADA@Example.com', password: 'hash-1234', role: 'instructor', isApproved: true });
  assert.match(teacher._id, /^[a-f0-9]{24}$/);
  assert.strictEqual(teacher.email, 'ada@example.com');
  assert.strictEqual(teacher.status, 'active');
  assert.deepStrictEqual(teacher.enrolledCourses, []);
  assert.ok(teacher.createdAt instanceof Date);
  student = await User.create({ name: 'Sam Student', email: 'sam@example.com', password: 'hash-1234', otpCode: '123456', otpExpiry: new Date(Date.now() + 60000) });
  assert.strictEqual(student.role, 'student');
});

test('validation errors look like Mongoose errors', async () => {
  const err = await rejects(() => User.create({ name: 'A', email: 'x@y.z', password: 'short' }));
  assert.strictEqual(err.name, 'ValidationError');
  assert.match(err.message, /User validation failed/);
  assert.match(err.message, /shorter than the minimum/);
  await rejects(() => User.create({ name: 'Okay Name', email: 'o@y.z', password: 'longenough', role: 'wizard' }), (e) => assert.match(e.message, /not a valid enum value/));
  await rejects(() => User.create({ email: 'o@y.z', password: 'longenough' }), (e) => assert.match(e.message, /Path `name` is required/));
});

test('unique email raises duplicate-key error (code 11000)', async () => {
  const err = await rejects(() => User.create({ name: 'Other Ada', email: 'ada@example.com', password: 'hash-1234' }));
  assert.strictEqual(err.code, 11000);
});

test('filters are cast like Mongoose (case-insensitive email lookup)', async () => {
  const found = await User.findOne({ email: 'Ada@EXAMPLE.com' });
  assert.strictEqual(String(found._id), String(teacher._id));
});

test('select:false fields are hidden unless requested', async () => {
  const plain = await User.findById(student._id);
  assert.strictEqual(plain.otpCode, undefined);
  const withOtp = await User.findById(student._id).select('+otpCode +otpExpiry');
  assert.strictEqual(withOtp.otpCode, '123456');
  assert.ok(withOtp.otpExpiry instanceof Date);
  const trimmed = await User.findById(student._id).select('-password -otpCode');
  assert.strictEqual(trimmed.password, undefined);
  const only = await User.findById(student._id).select('name role');
  assert.deepStrictEqual(Object.keys(only.toObject()).sort(), ['_id', 'name', 'role']);
});

test('save() writes only the changed fields and keeps hidden ones untouched', async () => {
  const u = await User.findById(student._id);
  u.name = 'Samuel Student';
  const before = memory.stats.writes;
  await u.save();
  assert.strictEqual(memory.stats.writes, before + 1);
  const raw = memory.data.get('users').get(String(student._id));
  assert.strictEqual(raw.name, 'Samuel Student');
  assert.strictEqual(raw.otpCode, '123456'); // not loaded, therefore not wiped
  const again = await User.findById(student._id);
  const w = memory.stats.writes;
  await again.save(); // nothing changed
  assert.strictEqual(memory.stats.writes, w);
});

test('verify-email flow: clearing select:false fields really removes them', async () => {
  const u = await User.findById(student._id).select('+otpCode +otpExpiry');
  u.isVerified = true;
  u.otpCode = undefined;
  u.otpExpiry = undefined;
  await u.save();
  const raw = memory.data.get('users').get(String(student._id));
  assert.strictEqual(raw.otpCode, undefined);
  assert.strictEqual(raw.isVerified, true);
});

test('updateOne with $inc / $set is applied atomically', async () => {
  await User.updateOne({ _id: student._id }, { $inc: { points: 5 } });
  await User.updateOne({ _id: student._id }, { $inc: { points: 3, studySeconds: 10 } });
  await User.updateOne({ _id: student._id }, { $set: { lastActive: new Date() } });
  const u = await User.findById(student._id);
  assert.strictEqual(u.points, 8);
  assert.strictEqual(u.studySeconds, 10);
  assert.ok(u.lastActive instanceof Date);
});

test('courses: array membership filters, populate with select, enrol and save', async () => {
  course = await Course.create({ title: 'Algebra', description: 'Numbers', faculty: teacher._id });
  course.students.push(student._id);
  await course.save();
  const mine = await Course.find({ students: student._id }).populate('faculty', 'name');
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].faculty.name, 'Ada Teacher');
  assert.strictEqual(mine[0].faculty.email, undefined);
  assert.strictEqual(String(mine[0].faculty._id), String(teacher._id));
  assert.ok(memory.stats.queries.some((q) => q.collection === 'courses' && q.where && q.where.op === 'array-contains'));
  const none = await Course.find({ students: teacher._id });
  assert.strictEqual(none.length, 0);
});

test('nested populate (course -> modules -> lectures/topics -> lectures/tests)', async () => {
  const mod = await Module.create({ title: 'Module 1', course: course._id });
  course.modules.push(mod._id);
  await course.save();
  const lec = await Lecture.create({ title: 'Intro', fileUrl: 'https://x.test/a', module: mod._id });
  const topic = await Topic.create({ title: 'Topic A', module: mod._id });
  const lec2 = await Lecture.create({ title: 'Deep dive', fileUrl: 'https://x.test/b', module: mod._id });
  topic.lectures.push(lec2._id);
  await topic.save();
  mod.lectures.push(lec._id);
  mod.topics.push(topic._id);
  const t = await Test.create({ title: 'Quiz', module: mod._id, questions: [{ questionText: '1+1?', options: ['1', '2'], correctAnswerIndex: 1 }] });
  mod.tests.push(t._id);
  await mod.save();

  const full = await Course.findById(course._id)
    .populate('faculty', 'name profilePicture')
    .populate({ path: 'modules', populate: [{ path: 'lectures' }, { path: 'liveSessions' }, { path: 'tests' }, { path: 'topics', populate: [{ path: 'lectures' }, { path: 'tests' }] }] });
  assert.strictEqual(full.modules.length, 1);
  assert.strictEqual(full.modules[0].lectures[0].title, 'Intro');
  assert.strictEqual(full.modules[0].topics[0].lectures[0].title, 'Deep dive');
  assert.strictEqual(full.modules[0].tests[0].questions[0].questionText, '1+1?');
  // the route maps populated tests with toObject() and strips answers
  const stripped = full.modules[0].tests.map((x) => { const o = x.toObject(); o.questions = o.questions.map(({ correctAnswerIndex, ...q }) => q); return o; });
  assert.strictEqual(stripped[0].questions[0].correctAnswerIndex, undefined);
  // embedded questions have ids like Mongoose subdocuments
  assert.match(String(t.questions[0]._id), /^[a-f0-9]{24}$/);
  assert.strictEqual(t.questions[0].difficulty, 'medium');
  // JSON output is plain and complete
  const json = JSON.parse(JSON.stringify(full));
  assert.strictEqual(json.modules[0].topics[0].lectures[0].title, 'Deep dive');
  assert.strictEqual(json.faculty.name, 'Ada Teacher');
  assert.strictEqual(json.id, undefined);
});

test('saving a populated document keeps references as plain ids', async () => {
  const c = await Course.findById(course._id).populate('modules').populate('faculty', 'name');
  c.title = 'Algebra II';
  await c.save();
  const raw = memory.data.get('courses').get(String(course._id));
  assert.strictEqual(raw.title, 'Algebra II');
  assert.strictEqual(typeof raw.faculty, 'string');
  assert.ok(raw.modules.every((m) => typeof m === 'string'));
});

test('lean + select + sort + limit + skip', async () => {
  for (let i = 0; i < 5; i++) await User.create({ name: `Learner ${i}`, email: `l${i}@x.test`, password: 'hash-1234', points: i * 10 });
  const top = await User.find({ status: 'active', role: 'student' }).select('name points').sort({ points: -1 }).limit(3).lean();
  assert.deepStrictEqual(top.map((u) => u.points), [40, 30, 20]);
  assert.strictEqual(top[0].password, undefined);
  assert.strictEqual(typeof top[0].toObject, 'undefined');
  const page = await User.find().sort('-createdAt').skip(1).limit(2);
  assert.strictEqual(page.length, 2);
  const names = await User.find({ name: { $regex: '^learner', $options: 'i' } }).sort('name').lean();
  assert.strictEqual(names.length, 5);
  assert.strictEqual(await User.countDocuments({ role: 'student' }), 6);
  assert.strictEqual(await User.countDocuments(), 7);
});

test('$in on _id, $ne with missing fields, $or, $gt on dates', async () => {
  const some = await User.find({ _id: { $in: [teacher._id, student._id, 'ffffffffffffffffffffffff'] } });
  assert.strictEqual(some.length, 2);
  assert.strictEqual((await User.find({ _id: { $in: [] } })).length, 0);
  const noPref = await User.find({ 'preferences.assignmentNotifications': { $ne: false } });
  assert.strictEqual(noPref.length, 7);
  const or = await User.find({ $or: [{ role: 'instructor' }, { points: { $gte: 30 } }] }).sort('points');
  assert.strictEqual(or.length, 3);
  const recent = await User.find({ lastActive: { $gte: new Date(Date.now() - 60000) } });
  assert.ok(recent.length >= 1);
  assert.strictEqual(await User.findById('not-an-id'), null);
  assert.strictEqual(await User.findById(undefined), null);
});

test('discussions: embedded replies, ids, likes toggling, populate("replies.author")', async () => {
  const d = await Discussion.create({ course: course._id, author: student._id, text: 'Question?' });
  d.replies.push({ author: teacher._id, text: 'Answer.' });
  await d.save();
  const fresh = await Discussion.findById(d._id).populate('replies.author', 'name role');
  const reply = fresh.replies[fresh.replies.length - 1];
  assert.strictEqual(reply.author.name, 'Ada Teacher');
  assert.match(String(reply._id), /^[a-f0-9]{24}$/);
  assert.ok(reply.createdAt instanceof Date);

  const thread = await Discussion.findById(d._id);
  const r = thread.replies.id(reply._id);
  assert.ok(r);
  const idx = r.likes.indexOf(student._id);
  if (idx !== -1) r.likes.splice(idx, 1); else r.likes.push(student._id);
  thread.likes.push(teacher._id);
  await thread.save();
  const again = await Discussion.findById(d._id);
  assert.deepStrictEqual(again.replies[0].likes, [student._id]);
  assert.deepStrictEqual(again.likes, [teacher._id]);
  const listed = await Discussion.find({ course: course._id }).populate('author', 'name role').populate('replies.author', 'name role').sort('-createdAt');
  assert.strictEqual(listed[0].author.name, 'Samuel Student');
});

test('results, distinct and deleteMany', async () => {
  const t = await Test.findOne({ title: 'Quiz' });
  await Result.create({ student: student._id, test: t._id, score: 1, total: 1, percentage: 100, answers: [1, null] });
  await Result.create({ student: teacher._id, test: t._id, score: 0, total: 1, percentage: 0, answers: [0], malpracticeLogs: [{ type: 'tab_switch' }] });
  const ranked = await Result.find({ test: t._id }).populate('student', 'name email').sort('-percentage');
  assert.strictEqual(ranked[0].student.name, 'Samuel Student');
  assert.deepStrictEqual(ranked[0].answers, [1, null]);
  const withLogs = await Result.findOne({ student: teacher._id });
  assert.strictEqual(withLogs.malpracticeLogs[0].type, 'tab_switch');
  assert.ok(withLogs.malpracticeLogs[0].timestamp instanceof Date);
  const ids = await Result.distinct('student', { test: t._id });
  assert.strictEqual(ids.length, 2);
  assert.strictEqual((await Result.deleteMany({ test: t._id })).deletedCount, 2);
  assert.strictEqual(await Result.countDocuments({ test: t._id }), 0);
});

test('progress: compound unique index', async () => {
  const lec = await Lecture.findOne({ title: 'Intro' });
  await Progress.create({ user: student._id, lecture: lec._id, completed: true });
  const err = await rejects(() => Progress.create({ user: student._id, lecture: lec._id, completed: true }));
  assert.strictEqual(err.code, 11000);
  const done = await Progress.distinct('lecture', { user: student._id, lecture: { $in: [lec._id] }, completed: true });
  assert.deepStrictEqual(done.map(String), [String(lec._id)]);
});

test('LmsItem: Mixed data, nested updates, $or access filters, certificate partial unique index', async () => {
  const s = await LmsItem.create({ type: 'sessions', owner: student._id, data: { startedAt: new Date(), lastHeartbeatAt: new Date(), activeSeconds: 0, status: 'active' } });
  const recent = await LmsItem.findOne({ type: 'sessions', owner: student._id, 'data.status': 'active', 'data.lastHeartbeatAt': { $gte: new Date(Date.now() - 7200000) } }).sort({ createdAt: -1 });
  assert.strictEqual(String(recent._id), String(s._id));
  recent.data.activeSeconds = (recent.data.activeSeconds || 0) + 30;
  recent.data.status = 'ended';
  await recent.save();
  assert.strictEqual((await LmsItem.findById(s._id)).data.activeSeconds, 30);

  await LmsItem.create({ type: 'assignments', owner: teacher._id, course: course._id, data: { title: 'HW1', status: 'published' } });
  await LmsItem.create({ type: 'assignments', owner: teacher._id, course: null, data: { title: 'Private', status: 'draft' } });
  const visible = await LmsItem.find({ type: 'assignments', $or: [{ owner: student._id }, { course: { $in: [course._id] } }, { recipients: student._id }], 'data.status': { $in: ['published', 'open'] } }).sort({ createdAt: -1 }).limit(100).lean();
  assert.strictEqual(visible.length, 1);
  assert.strictEqual(visible[0].data.title, 'HW1');
  const emptyIn = await LmsItem.find({ type: 'files', $or: [{ owner: student._id }, { course: { $in: [] } }] });
  assert.strictEqual(emptyIn.length, 0);

  const cert = { certificateNumber: 'CPS-LP-1', courseId: String(course._id), certificateType: 'course', status: 'issued' };
  const c1 = await LmsItem.create({ type: 'certificates', owner: student._id, data: cert });
  const dup = await rejects(() => LmsItem.create({ type: 'certificates', owner: student._id, data: { ...cert, certificateNumber: 'CPS-LP-2' } }));
  assert.strictEqual(dup.code, 11000);
  c1.data.status = 'revoked';
  await c1.save();
  await LmsItem.create({ type: 'certificates', owner: student._id, data: { ...cert, certificateNumber: 'CPS-LP-3' } }); // allowed again after revoke
  const verify = await LmsItem.findOne({ type: 'certificates', 'data.certificateNumber': 'CPS-LP-3' }).lean();
  assert.strictEqual(verify.data.status, 'issued');
  assert.ok(memory.stats.queries.some((q) => q.where && q.where.field === 'data.certificateNumber'));

  const item = await LmsItem.create({ type: 'audit-logs', owner: teacher._id, data: { action: 'x' } });
  await item.populate('owner', 'name email');
  assert.strictEqual(item.owner.name, 'Ada Teacher');

  const exported = await LmsItem.find({ $or: [{ owner: student._id }, { recipients: student._id }] }).select('-data.storedName').limit(2000).lean();
  assert.ok(exported.length >= 2);
});

test('insertMany + notifications flow', async () => {
  const learners = await User.find({ _id: { $in: course.students }, 'preferences.assignmentNotifications': { $ne: false } }).select('_id');
  assert.strictEqual(learners.length, 1);
  const docs = await LmsItem.insertMany(learners.map((l) => ({ type: 'notifications', owner: l._id, data: { title: 'New' } })));
  assert.strictEqual(docs.length, 1);
  assert.strictEqual(docs[0].readAt, null);
});

test('findByIdAndUpdate honours validators and returns the new document', async () => {
  const updated = await Course.findByIdAndUpdate(course._id, { title: 'Algebra III', level: 'Advanced' }, { new: true, runValidators: true });
  assert.strictEqual(updated.title, 'Algebra III');
  assert.strictEqual((await Course.findById(course._id)).level, 'Advanced');
  await rejects(() => Course.findByIdAndUpdate(course._id, { level: 'Expert' }, { new: true, runValidators: true }), (e) => assert.strictEqual(e.name, 'ValidationError'));
  assert.strictEqual(await Course.findByIdAndUpdate('ffffffffffffffffffffffff', { title: 'x' }, { new: true }), null);
});

test('req.user style saves (preferences, Mixed) and the id virtual', async () => {
  const user = await User.findById(student._id);
  user.id = String(user._id); // auth middleware does this; must not break saving
  user.preferences = { ...(user.preferences || {}), weeklySummary: true };
  await user.save();
  assert.strictEqual((await User.findById(student._id)).preferences.weeklySummary, true);
  assert.strictEqual(user.id, user._id);
  assert.strictEqual(Object.keys(user.toObject()).includes('id'), false);
});

test('live sessions, deletes and cleanup', async () => {
  const mod = await Module.findOne({ title: 'Module 1' });
  const live = await LiveSession.create({ topic: 'Q&A', roomId: `room-${Date.now()}`, isActive: true, module: mod._id });
  const found = await LiveSession.findOne({ roomId: live.roomId }).populate({ path: 'module', populate: { path: 'course' } });
  assert.strictEqual(String(found.module.course._id), String(course._id));
  assert.ok(found.module.course.students.some((id) => String(id) === String(student._id)));
  await rejects(() => LiveSession.create({ topic: 'Dup', roomId: live.roomId, module: mod._id }), (e) => assert.strictEqual(e.code, 11000));
  await LiveSession.findByIdAndDelete(live._id);
  assert.strictEqual(await LiveSession.findById(live._id), null);
  const doc = await LmsItem.findOne({ type: 'audit-logs' });
  await doc.deleteOne();
  assert.strictEqual(await LmsItem.countDocuments({ type: 'audit-logs' }), 0);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
