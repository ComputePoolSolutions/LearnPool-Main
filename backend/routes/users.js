const express = require('express');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');

// Multer Config for Profile Pictures
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, `profile-${req.user.id}-${Date.now()}${path.extname(file.originalname)}`);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed'));
    }
  }
});

// @desc    Get all approved teachers
// @route   GET /api/users/teachers
// @access  Public
router.get('/teachers', async (req, res) => {
  try {
    const teachers = await User.find({ role: { $in: ['faculty', 'instructor'] }, isApproved: true, status: 'active' }).select('name teacherCode profilePicture');
    res.status(200).json({ success: true, count: teachers.length, data: teachers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Get all users (admin only)
// @route   GET /api/users
// @access  Private/Admin
router.get('/', protect, authorize('admin'), async (req, res) => {
  try {
    const users = await User.find().select('-password -otpCode -otpExpiry').sort('-createdAt').limit(500);
    res.status(200).json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Get students for current teacher
// @route   GET /api/users/my-students
// @access  Private (Faculty/Admin)
router.get('/my-students', protect, authorize('faculty', 'admin'), async (req, res) => {
  try {
    let query = { role: 'student' };
    if (req.user.role !== 'admin') {
      const Course=require('../models/Course');
      const courses=await Course.find({faculty:req.user._id}).select('students');
      const ids=[...new Set(courses.flatMap(c=>c.students.map(id=>String(id))))];
      query={role:'student',_id:{$in:ids}};
    }
    const students = await User.find(query).select('-password -otpCode -otpExpiry').sort('-createdAt');
    res.status(200).json({ success: true, count: students.length, data: students });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Approve faculty (admin only)
// @route   PUT /api/users/:id/approve
// @access  Private/Admin
router.put('/:id/approve', protect, authorize('admin'), async (req, res) => {
  try {
    let user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (!['faculty', 'instructor'].includes(user.role)) {
      return res.status(400).json({ success: false, message: 'User is not an instructor.' });
    }

    user.isApproved = true;
    await user.save();

    res.status(200).json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/:id/access', protect, authorize('admin'), async(req,res,next)=>{
  try{
    const {role,status}=req.body;
    if(role!==undefined&&!['student','instructor','admin'].includes(role))return res.status(400).json({success:false,message:'Choose a valid role.'});
    if(status!==undefined&&!['active','suspended','disabled'].includes(status))return res.status(400).json({success:false,message:'Choose a valid account status.'});
    const user=await User.findById(req.params.id);
    if(!user)return res.status(404).json({success:false,message:'User not found.'});
    if(String(user._id)===String(req.user._id)&&status&&status!=='active')return res.status(400).json({success:false,message:'You cannot suspend your own admin account.'});
    if(user.role==='admin'&&status&&status!=='active'){
      const count=await User.countDocuments({role:'admin',status:'active'});
      if(count<=1)return res.status(400).json({success:false,message:'At least one active admin must remain.'});
    }
    if(user.role==='admin'&&role&&role!=='admin'){
      const count=await User.countDocuments({role:'admin',status:'active'});
      if(count<=1)return res.status(400).json({success:false,message:'At least one active admin must remain.'});
    }
    const before={role:user.role,status:user.status};
    if(role)user.role=role;
    if(status)user.status=status;
    if(role==='instructor')user.isApproved=true;
    await user.save();
    const LmsItem=require('../models/LmsItem');
    await LmsItem.create({type:'audit-logs',owner:req.user._id,data:{action:'user.access_updated',targetId:String(user._id),before,after:{role:user.role,status:user.status}}});
    const safe=user.toObject();delete safe.password;delete safe.otpCode;delete safe.otpExpiry;
    res.json({success:true,data:safe});
  }catch(e){next(e)}
});

// @desc    Get stats
// @route   GET /api/users/stats
// @access  Private/Admin
router.get('/stats', protect, authorize('admin'), async (req, res) => {
    try {
        const usersCount = await User.countDocuments();
        const Course = require('../models/Course');
        const coursesCount = await Course.countDocuments();
        
        res.status(200).json({ success: true, data: { users: usersCount, courses: coursesCount } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private/Admin
router.delete('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.role === 'admin') {
      return res.status(400).json({ success: false, message: 'Cannot delete an admin' });
    }

    await User.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, data: {} });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Get current user profile
// @route   GET /api/users/profile
// @access  Private
router.get('/profile', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.status(200).json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/preferences', protect, async(req,res,next)=>{
  try{
    const allowed=['emailNotifications','weeklySummary','assignmentNotifications','classNotifications','messageNotifications','announcementNotifications'];
    const preferences={...(req.user.preferences||{})};
    for(const key of allowed)if(typeof req.body[key]==='boolean')preferences[key]=req.body[key];
    req.user.preferences=preferences;await req.user.save();
    res.json({success:true,data:preferences});
  }catch(e){next(e)}
});

router.get('/export', protect, async(req,res,next)=>{
  try{
    const [Progress,Result,Course,LmsItem]=['../models/Progress','../models/Result','../models/Course','../models/LmsItem'].map(x=>require(x));
    const [profile,courses,progress,results,workspace]=await Promise.all([
      User.findById(req.user._id).select('-password -otpCode -otpExpiry').lean(),
      Course.find({students:req.user._id}).select('title description category status createdAt').lean(),
      Progress.find({user:req.user._id}).lean(),Result.find({student:req.user._id}).select('-answers -malpracticeLogs').lean(),
      LmsItem.find({$or:[{owner:req.user._id},{recipients:req.user._id}]}).select('-data.storedName').limit(2000).lean()
    ]);
    res.setHeader('Content-Type','application/json');res.setHeader('Content-Disposition',`attachment; filename="learnpool-data-${req.user._id}.json"`);
    res.json({exportedAt:new Date(),profile,courses,progress,assessmentResults:results,workspace});
  }catch(e){next(e)}
});

// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
router.put('/profile', protect, upload.single('profilePicture'), async (req, res) => {
  try {
    const { name, email, phoneNumber, bio, skills, interests, oldPassword, newPassword } = req.body;
    
    let user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Update basic info
    if (name) user.name = name;
    if (email) user.email = email;
    if (phoneNumber) user.phoneNumber = phoneNumber;
    if (bio) user.bio = bio;
    if (skills) user.skills = Array.isArray(skills) ? skills : skills.split(',').map(s => s.trim());
    if (interests) user.interests = Array.isArray(interests) ? interests : interests.split(',').map(i => i.trim());
    
    if (req.file) {
      user.profilePicture = `/uploads/${req.file.filename}`;
    }

    // Password Update
    if (newPassword) {
      if (!oldPassword) {
        return res.status(400).json({ success: false, message: 'Please provide old password to update password' });
      }
      const isMatch = await bcrypt.compare(oldPassword, user.password);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Incorrect old password' });
      }
      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(newPassword, salt);
    }

    await user.save();
    
    const updatedUser = user.toObject();
    delete updatedUser.password;

    res.status(200).json({ success: true, data: updatedUser });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
