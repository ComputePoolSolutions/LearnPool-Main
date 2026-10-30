const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Module = require('../models/Module');
const Course = require('../models/Course');
const Lecture = require('../models/Lecture');
const LiveSession = require('../models/LiveSession');
const Topic = require('../models/Topic');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// Multer setup for file uploads
const lessonDir=path.join(__dirname,'..','uploads','learning');
fs.mkdirSync(lessonDir,{recursive:true});
const allowedExt=new Set(['.pdf','.doc','.docx','.ppt','.pptx','.xls','.xlsx','.txt','.png','.jpg','.jpeg','.mp4']);
const storage=multer.diskStorage({destination(req,file,cb){cb(null,lessonDir)},filename(req,file,cb){cb(null,`${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)}});
const upload=multer({storage,limits:{fileSize:100*1024*1024},fileFilter(req,file,cb){allowedExt.has(path.extname(file.originalname).toLowerCase())?cb(null,true):cb(Object.assign(new Error('Unsupported lesson file type.'),{status:400}))}});
const parseLessonUpload=(req,res,next)=>upload.single('file')(req,res,error=>{if(!error)return next();return res.status(error.code==='LIMIT_FILE_SIZE'?413:(error.status||400)).json({success:false,message:error.code==='LIMIT_FILE_SIZE'?'Lesson files must be 100 MB or smaller.':error.message})});
const validHttpUrl=value=>{try{const u=new URL(value);return u.protocol==='http:'||u.protocol==='https:'}catch{return false}};

// @desc    Add module to course
// @route   POST /api/modules/:courseId
// @access  Private (Faculty/Admin)
router.post('/:courseId', protect, authorize('faculty', 'admin'), async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    if (course.faculty.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const newModule = await Module.create({
      title: req.body.title,
      course: req.params.courseId
    });

    course.modules.push(newModule._id);
    await course.save();

    res.status(201).json({ success: true, data: newModule });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Upload lecture to module
// @route   POST /api/modules/:moduleId/lectures
// @access  Private (Faculty/Admin)
router.post('/:moduleId/lectures', protect, authorize('faculty', 'admin'), parseLessonUpload, async (req, res) => {
  try {
    const mod = await Module.findById(req.params.moduleId).populate('course');
    if (!mod) return res.status(404).json({ success: false, message: 'Module not found' });

    if (mod.course.faculty.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if(!req.body.title||(!req.file&&!validHttpUrl(req.body.fileUrl)))return res.status(400).json({success:false,message:'Provide a lesson title and an HTTP(S) resource link or upload.'});

    const lecture = await Lecture.create({
      title: req.body.title,
      fileUrl: req.file ? `/uploads/learning/${req.file.filename}` : req.body.fileUrl,
      fileType: req.file ? req.file.mimetype : 'external/link',
      module: req.params.moduleId
    });

    mod.lectures.push(lecture._id);
    await mod.save();

    res.status(201).json({ success: true, data: lecture });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Create/Start Live Session
// @route   POST /api/modules/:moduleId/live
// @access  Private (Faculty/Admin)
router.post('/:moduleId/live', protect, authorize('faculty', 'admin'), async (req, res) => {
  try {
    const mod = await Module.findById(req.params.moduleId).populate('course');
    if (!mod) return res.status(404).json({ success: false, message: 'Module not found' });

    if (mod.course.faculty.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const roomId = `room-${Date.now()}`;
    const liveSession = await LiveSession.create({
      topic: req.body.topic,
      roomId,
      isActive: true,
      module: req.params.moduleId
    });

    mod.liveSessions.push(liveSession._id);
    await mod.save();

    res.status(201).json({ success: true, data: liveSession });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    End Live Session
// @route   PUT /api/modules/live/:sessionId/end
// @access  Private (Faculty/Admin)
router.put('/live/:sessionId/end', protect, authorize('faculty', 'admin'), async (req, res) => {
  try {
    const session = await LiveSession.findById(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const mod = await Module.findById(session.module).populate('course');
    if (mod.course.faculty.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    session.isActive = false;
    await session.save();

    res.status(200).json({ success: true, data: session });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Delete module
// @route   DELETE /api/modules/:moduleId
// @access  Private (Faculty/Admin)
router.delete('/:moduleId', protect, authorize('faculty', 'admin'), async (req, res) => {
  try {
    const mod = await Module.findById(req.params.moduleId).populate('course');
    if (!mod) return res.status(404).json({ success: false, message: 'Module not found' });

    if (mod.course.faculty.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Remove from Course
    const course = await Course.findById(mod.course._id);
    course.modules = course.modules.filter(id => id.toString() !== mod._id.toString());
    await course.save();

    await Module.findByIdAndDelete(req.params.moduleId);
    res.status(200).json({ success: true, data: {} });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Delete lecture
// @route   DELETE /api/modules/lectures/:lectureId
// @access  Private (Faculty/Admin)
router.delete('/lectures/:lectureId', protect, authorize('faculty', 'admin'), async (req, res) => {
  try {
    const lecture = await Lecture.findById(req.params.lectureId);
    if (!lecture) return res.status(404).json({ success: false, message: 'Lecture not found' });

    const mod = await Module.findById(lecture.module).populate('course');
    if (mod.course.faculty.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Remove from Module
    mod.lectures = mod.lectures.filter(id => id.toString() !== lecture._id.toString());
    await mod.save();

    await Lecture.findByIdAndDelete(req.params.lectureId);
    res.status(200).json({ success: true, data: {} });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Delete live session
// @route   DELETE /api/modules/live/:sessionId
// @access  Private (Faculty/Admin)
router.delete('/live/:sessionId', protect, authorize('faculty', 'admin'), async (req, res) => {
  try {
    const session = await LiveSession.findById(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const mod = await Module.findById(session.module).populate('course');
    if (mod.course.faculty.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Remove from Module
    mod.liveSessions = mod.liveSessions.filter(id => id.toString() !== session._id.toString());
    await mod.save();

    await LiveSession.findByIdAndDelete(req.params.sessionId);
    res.status(200).json({ success: true, data: {} });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Add topic to module
// @route   POST /api/modules/:moduleId/topics
// @access  Private (Faculty/Admin)
router.post('/:moduleId/topics', protect, authorize('faculty', 'admin'), async (req, res) => {
  try {
    const mod = await Module.findById(req.params.moduleId).populate('course');
    if (!mod) return res.status(404).json({ success: false, message: 'Module not found' });

    if (mod.course.faculty.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const topic = await Topic.create({
      title: req.body.title,
      description: req.body.description,
      module: req.params.moduleId
    });

    mod.topics.push(topic._id);
    await mod.save();

    res.status(201).json({ success: true, data: topic });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Upload lecture to topic
// @route   POST /api/modules/topics/:topicId/lectures
// @access  Private (Faculty/Admin)
router.post('/topics/:topicId/lectures', protect, authorize('faculty', 'admin'), parseLessonUpload, async (req, res) => {
  try {
    const topic = await Topic.findById(req.params.topicId).populate({
        path: 'module',
        populate: { path: 'course' }
    });
    if (!topic) return res.status(404).json({ success: false, message: 'Topic not found' });

    if (topic.module.course.faculty.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if(!req.body.title||(!req.file&&!validHttpUrl(req.body.fileUrl)))return res.status(400).json({success:false,message:'Provide a lesson title and an HTTP(S) resource link or upload.'});

    const lecture = await Lecture.create({
      title: req.body.title,
      fileUrl: req.file ? `/uploads/learning/${req.file.filename}` : req.body.fileUrl,
      fileType: req.file ? req.file.mimetype : 'external/link',
      module: topic.module._id
    });

    topic.lectures.push(lecture._id);
    await topic.save();

    res.status(201).json({ success: true, data: lecture });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Delete topic
// @route   DELETE /api/modules/topics/:topicId
// @access  Private (Faculty/Admin)
router.delete('/topics/:topicId', protect, authorize('faculty', 'admin'), async (req, res) => {
  try {
    const topic = await Topic.findById(req.params.topicId).populate({
        path: 'module',
        populate: { path: 'course' }
    });
    if (!topic) return res.status(404).json({ success: false, message: 'Topic not found' });

    if (topic.module.course.faculty.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Remove from Module
    const mod = await Module.findById(topic.module._id);
    mod.topics = mod.topics.filter(id => id.toString() !== topic._id.toString());
    await mod.save();

    await Topic.findByIdAndDelete(req.params.topicId);
    res.status(200).json({ success: true, data: {} });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/lectures/:lectureId/resource', protect, async (req,res,next)=>{
  try{
    const lecture=await Lecture.findById(req.params.lectureId).populate({path:'module',populate:{path:'course'}});
    if(!lecture)return res.status(404).json({success:false,message:'Lesson not found.'});
    if(lecture.fileType==='external/link'){
      if(!validHttpUrl(lecture.fileUrl))return res.status(404).json({success:false,message:'Lesson resource is unavailable.'});
      return res.redirect(lecture.fileUrl);
    }
    const course=lecture.module?.course,user=req.user;
    const permitted=user.role==='admin'||String(course?.faculty)===String(user._id)||(user.role==='student'&&course?.students.some(id=>String(id)===String(user._id)));
    if(!permitted)return res.status(403).json({success:false,message:'You are not enrolled in this course.'});
    const filename=path.basename(lecture.fileUrl);
    return res.download(path.join(lessonDir,filename),filename);
  }catch(e){next(e)}
});

module.exports = router;
