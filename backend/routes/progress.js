const express = require('express');
const db = require('../db');
const router = express.Router();
const Progress = require('../models/Progress');
const Lecture = require('../models/Lecture');
const Course = require('../models/Course');
const { protect, authorize } = require('../middleware/auth');

// @desc    Mark lecture as completed
// @route   POST /api/progress/lecture/:lectureId
// @access  Private (Student)
router.post('/lecture/:lectureId', protect, authorize('student'), async (req, res) => {
  try {
    const lectureId = req.params.lectureId;
    const userId = req.user.id;
    if (!db.isValidObjectId(lectureId)) return res.status(400).json({ success:false,message:'Invalid lecture.' });
    const lecture=await Lecture.findById(lectureId).populate({path:'module',populate:{path:'course'}});
    if(!lecture)return res.status(404).json({success:false,message:'Lecture not found.'});
    const course=lecture.module?.course;
    if(!course||!course.students.some(id=>String(id)===String(userId)))return res.status(403).json({success:false,message:'You are not enrolled in this course.'});

    let progress = await Progress.findOne({ user: userId, lecture: lectureId });
    const firstCompletion=!progress||!progress.completed;

    if (!progress) {
      progress = await Progress.create({
        user: userId,
        lecture: lectureId,
        completed: true
      });
    } else {
      progress.completed = true;
      await progress.save();
    }
    if(firstCompletion)await require('../models/User').updateOne({_id:userId},{$inc:{points:5}});

    res.status(200).json({ success: true, data: progress });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Get student's progress for a course
// @route   GET /api/progress/course/:courseId
// @access  Private (Student)
router.get('/course/:courseId', protect, authorize('student'), async (req, res) => {
  try {
    const courseId = req.params.courseId;
    const userId = req.user.id;

    if (!db.isValidObjectId(courseId)) return res.status(400).json({success:false,message:'Invalid course.'});
    const course=await Course.findById(courseId).populate({path:'modules',populate:[{path:'lectures'},{path:'topics',populate:'lectures'}]});
    if(!course)return res.status(404).json({success:false,message:'Course not found.'});
    if(!course.students.some(id=>String(id)===String(userId)))return res.status(403).json({success:false,message:'You are not enrolled in this course.'});
    const ids=[];course.modules.forEach(m=>{m.lectures.forEach(l=>ids.push(l._id));m.topics.forEach(t=>t.lectures.forEach(l=>ids.push(l._id)))});
    const progress = await Progress.find({ user: userId, lecture:{$in:ids} });
    res.status(200).json({ success: true, data: progress });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
