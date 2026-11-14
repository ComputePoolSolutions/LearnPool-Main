const Course = require('../models/Course');
const Progress = require('../models/Progress');

// Course with every lesson loaded (module lessons and topic lessons).
const loadCourseWithLessons = id => Course.findById(id)
  .populate('faculty', 'name email')
  .populate({ path: 'modules', populate: [{ path: 'lectures' }, { path: 'topics', populate: { path: 'lectures' } }] });

const lessonsOf = course => {
  const seen = new Map();
  for (const mod of course.modules || []) {
    for (const lecture of mod.lectures || []) seen.set(String(lecture._id), lecture);
    for (const topic of mod.topics || []) for (const lecture of topic.lectures || []) seen.set(String(lecture._id), lecture);
  }
  return [...seen.values()];
};

// How much of a course a learner has finished, and when they finished it.
async function completionFor(userId, course) {
  const lessons = lessonsOf(course);
  const ids = lessons.map(l => String(l._id));
  const rows = ids.length ? await Progress.find({ user: String(userId), lecture: { $in: ids }, completed: true }).lean() : [];
  const done = new Map(rows.map(r => [String(r.lecture), r]));
  const completed = ids.filter(id => done.has(id)).length;
  const total = ids.length;
  const percentage = total ? Math.round((completed / total) * 100) : 0;
  const finished = total > 0 && completed === total;
  const times = rows.map(r => new Date(r.updatedAt || r.createdAt).getTime()).filter(Number.isFinite);
  return {
    total, completed, percentage, finished,
    completedAt: finished && times.length ? new Date(Math.max(...times)) : null,
    lessons: lessons.map(l => ({ id: String(l._id), title: l.title, completed: done.has(String(l._id)), completedAt: done.get(String(l._id))?.updatedAt || done.get(String(l._id))?.createdAt || null })),
  };
}

module.exports = { loadCourseWithLessons, lessonsOf, completionFor };
