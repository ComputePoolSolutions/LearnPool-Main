const express = require('express');
const Course = require('../models/Course');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// @desc    Get all courses
// @route   GET /api/courses
// @access  Public (or Private depending on needs, assuming logged in user can see courses)
router.get('/', protect, async (req, res) => {
  try {
    let query;
    // Faculty should only see their own courses
    if (req.user.role === 'faculty' || req.user.role === 'instructor') {
      query = Course.find({ faculty: req.user.id });
    } else if (req.user.role === 'student') {
      query = Course.find({ students: req.user.id });
    } else {
      // Admin can see all courses
      query = Course.find();
    }

    const courses = await query.populate('faculty', 'name');
    res.status(200).json({ success: true, data: courses });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/catalog', protect, async (req,res,next)=>{
  try {
    const courses=await Course.find({status:'published'}).populate('faculty','name profilePicture').sort({createdAt:-1}).limit(100);
    res.json({success:true,data:courses});
  }catch(e){next(e)}
});

router.get('/enrollments', protect, authorize('admin'), async(req,res,next)=>{
  try{
    const courses=await Course.find().select('title students').populate('students','name email role').sort({title:1}).lean();
    const data=courses.flatMap(course=>(course.students||[]).map(student=>({id:String(course._id)+'-'+String(student._id),courseId:String(course._id),courseName:course.title,studentId:String(student._id),studentName:student.name,email:student.email})));
    res.json({success:true,data});
  }catch(e){next(e)}
});

// @desc    Get single course (only if enrolled or faculty/admin)
// @route   GET /api/courses/:id
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate('faculty', 'name profilePicture')
      .populate({
        path: 'modules',
        populate: [
          { path: 'lectures' },
          { path: 'liveSessions' },
          { path: 'tests' },
          { path: 'topics', populate: [{ path: 'lectures' }, { path: 'tests' }] }
        ]
      });

    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    // Check access
    if ((req.user.role === 'faculty' || req.user.role === 'instructor') && course.faculty._id.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this course' });
    }

    if (req.user.role === 'student' && !course.students.some(id => id.toString() === req.user.id)) {
      return res.status(403).json({ success: false, message: 'Not enrolled in this course' });
    }

    // Calculate progress for students
    let progressPercentage = 0;
    let completedLectures = [];
    if (req.user.role === 'student') {
        course.modules?.forEach(mod=>{
          mod.tests=(mod.tests||[]).map(test=>{const item=test.toObject();item.questions=(item.questions||[]).map(({correctAnswerIndex,...question})=>question);return item});
          mod.topics?.forEach(topic=>{topic.tests=(topic.tests||[]).map(test=>{const item=test.toObject();item.questions=(item.questions||[]).map(({correctAnswerIndex,...question})=>question);return item})});
        });
        const Progress = require('../models/Progress');
        const userProgress = await Progress.find({ user: req.user.id });
        completedLectures = userProgress.filter(p => p.completed).map(p => p.lecture.toString());
        
        let totalLectures = 0;
        let completedInCourse = 0;
        
        course.modules?.forEach(mod => {
            mod.topics?.forEach(topic => {
                topic.lectures?.forEach(lec => {
                    totalLectures++;
                    if (completedLectures.includes(lec._id.toString())) {
                        completedInCourse++;
                    }
                });
            });
            // Also count direct lectures if any (legacy)
            mod.lectures?.forEach(lec => {
                totalLectures++;
                if (completedLectures.includes(lec._id.toString())) {
                    completedInCourse++;
                }
            });
        });
        
        progressPercentage = totalLectures > 0 ? (completedInCourse / totalLectures) * 100 : 0;
    }

    res.status(200).json({ 
        success: true, 
        data: course, 
        progress: Math.round(progressPercentage),
        completedLectures: completedLectures
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// @desc    Create new course
// @route   POST /api/courses
// @access  Private (Faculty/Admin)
router.post('/', protect, authorize('faculty', 'admin'), async (req, res) => {
  try {
    const { title, description, category, level } = req.body;
    if (!title || !description) return res.status(400).json({ success:false, message:'Course name and description are required.' });
    const course = await Course.create({ title:String(title).trim().slice(0,160), description:String(description).trim().slice(0,3000), category:String(category||'').slice(0,80), level:String(level||'Beginner'), faculty:req.user.id });
    res.status(201).json({ success: true, data: course });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Update course
// @route   PUT /api/courses/:id
// @access  Private (Faculty/Admin)
router.put('/:id', protect, authorize('faculty', 'admin'), async (req, res) => {
  try {
    let course = await Course.findById(req.params.id);

    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    // Make sure user is course owner
    if (course.faculty.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to update this course' });
    }

    const updates={};
    for(const key of ['title','description','category','level','status','thumbnail'])if(req.body[key]!==undefined)updates[key]=req.body[key];
    course = await Course.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true
    });

    res.status(200).json({ success: true, data: course });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Delete course
// @route   DELETE /api/courses/:id
// @access  Private (Faculty/Admin)
router.delete('/:id', protect, authorize('faculty', 'admin'), async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);

    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    if (course.faculty.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this course' });
    }

    course.status='archived';
    await course.save();
    res.status(200).json({ success: true, data: course });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Enroll in course
// @route   POST /api/courses/:id/enroll
// @access  Private (Student)
router.post('/:id/enroll', protect, authorize('student'), async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);

    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    if (course.students.includes(req.user.id)) {
      return res.status(400).json({ success: false, message: 'Already enrolled' });
    }

    course.students.push(req.user.id);
    await course.save();

    const user = await User.findById(req.user.id);
    user.enrolledCourses.push(course._id);
    await user.save();

    res.status(200).json({ success: true, message: 'Successfully enrolled' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/:id/enrollments', protect, authorize('instructor','admin'), async(req,res,next)=>{
  try{
    const course=await Course.findById(req.params.id);
    if(!course)return res.status(404).json({success:false,message:'Course not found.'});
    if(req.user.role!=='admin'&&String(course.faculty)!==String(req.user._id))return res.status(403).json({success:false,message:'You do not teach this course.'});
    const student=await User.findById(req.body.userId);
    if(!student||student.role!=='student')return res.status(404).json({success:false,message:'Choose a student account.'});
    if(!course.students.some(id=>String(id)===String(student._id)))course.students.push(student._id);
    if(!student.enrolledCourses.some(id=>String(id)===String(course._id)))student.enrolledCourses.push(course._id);
    await Promise.all([course.save(),student.save()]);
    await require('../models/LmsItem').create({type:'audit-logs',owner:req.user._id,data:{action:'enrollment.created',courseId:String(course._id),studentId:String(student._id)}});
    res.status(201).json({success:true,message:'Learner enrolled.'});
  }catch(e){next(e)}
});

router.delete('/:id/enrollments/:userId',protect,authorize('admin'),async(req,res,next)=>{
  try{
    const course=await Course.findById(req.params.id),student=await User.findById(req.params.userId);
    if(!course||!student)return res.status(404).json({success:false,message:'Course or student not found.'});
    course.students=course.students.filter(id=>String(id)!==String(student._id));student.enrolledCourses=student.enrolledCourses.filter(id=>String(id)!==String(course._id));
    await Promise.all([course.save(),student.save()]);
    await require('../models/LmsItem').create({type:'audit-logs',owner:req.user._id,data:{action:'enrollment.removed',courseId:String(course._id),studentId:String(student._id)}});
    res.json({success:true});
  }catch(e){next(e)}
});

module.exports = router;
