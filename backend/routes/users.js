const express = require('express');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { ASSIGNABLE_ROLES, normalizeEmail, isAllowedEmail, emailRuleMessage, initialPasswordFor, generateTeacherCode } = require('../utils/accounts');

// ---- Profile pictures -------------------------------------------------------
// JPG / PNG / WebP only, 2 MB maximum. The file is kept in memory first so its real
// content (not just the name the browser sent) can be checked before anything is written.
const avatarDir = path.join(__dirname, '..', 'uploads', 'avatars');
fs.mkdirSync(avatarDir, { recursive: true });
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => AVATAR_MIME.has(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error('Use a JPG, PNG or WebP image.'), { status: 400 }))
});
const parseAvatar = (req, res, next) => avatarUpload.single('picture')(req, res, error => {
  if (!error) return next();
  const tooBig = error.code === 'LIMIT_FILE_SIZE';
  return res.status(tooBig ? 413 : (error.status || 400)).json({ success: false, message: tooBig ? 'Profile pictures must be 2 MB or smaller.' : (error.status ? error.message : 'Could not read that image. Use a JPG, PNG or WebP file under 2 MB.') });
});
// Detect the real image type from the file's first bytes.
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}
const removeAvatarFile = url => {
  if (typeof url !== 'string' || !url.startsWith('/uploads/avatars/')) return;
  const target = path.join(avatarDir, path.basename(url));
  try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch { /* ignore */ }
};

// Account fields that are safe to return to the admin UI.
const safeUser = user => {
  const o = typeof user.toObject === 'function' ? user.toObject() : { ...user };
  for (const k of ['password', 'otpCode', 'otpExpiry', 'passwordResetToken', 'passwordResetExpiry']) delete o[k];
  return o;
};
const audit = (req, data) => require('../models/LmsItem').create({ type: 'audit-logs', owner: req.user._id, data }).catch(() => {});

// @desc    Get all approved teachers
// @route   GET /api/users/teachers
// @access  Public
router.get('/teachers', protect, async (req, res) => {
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
    if(role!==undefined&&!ASSIGNABLE_ROLES.includes(role))return res.status(400).json({success:false,message:'Choose Student or Instructor.'});
    if(status!==undefined&&!['active','suspended','disabled'].includes(status))return res.status(400).json({success:false,message:'Choose a valid account status.'});
    const user=await User.findById(req.params.id);
    if(!user)return res.status(404).json({success:false,message:'User not found.'});
    if(role!==undefined&&user.role==='admin')return res.status(400).json({success:false,message:'Administrator accounts cannot be changed here.'});
    if(role!==undefined&&!isAllowedEmail(normalizeEmail(user.email)))return res.status(400).json({success:false,message:`This account's email is not allowed for a ${role} account. ${emailRuleMessage()}`});
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
    if(role==='instructor'){user.isApproved=true;if(!user.teacherCode)user.teacherCode=generateTeacherCode();}
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
    await audit(req, { action: 'user.deleted', targetId: String(req.params.id), email: user.email });
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
router.put('/profile', protect, async (req, res) => {
  try {
    const { name, phoneNumber, bio, skills, interests, oldPassword, newPassword } = req.body;
    
    let user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Update basic info
    if (name) user.name = name;
    if (phoneNumber) user.phoneNumber = phoneNumber;
    if (bio) user.bio = bio;
    if (skills) user.skills = Array.isArray(skills) ? skills : skills.split(',').map(s => s.trim());
    if (interests) user.interests = Array.isArray(interests) ? interests : interests.split(',').map(i => i.trim());
    
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
      user.mustChangePassword = false;
      user.passwordChangedAt = new Date();
    }

    await user.save();
    
    const updatedUser = user.toObject();
    delete updatedUser.password;

    res.status(200).json({ success: true, data: updatedUser });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Admin: create accounts (the only way Student / Instructor accounts come to exist)
// ---------------------------------------------------------------------------
// @route   POST /api/users
// @access  Private/Admin
router.post('/', protect, authorize('admin'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = normalizeEmail(req.body.email);
    const role = String(req.body.role || '').trim().toLowerCase();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ success: false, message: 'Enter the person\u2019s full name.' });
    if (!ASSIGNABLE_ROLES.includes(role)) return res.status(400).json({ success: false, message: 'Choose Student or Instructor.' });
    if (!isAllowedEmail(email)) return res.status(400).json({ success: false, message: emailRuleMessage() });
    if (await User.findOne({ email })) return res.status(409).json({ success: false, message: 'An account with this email already exists.' });

    // Initial password = the email username; only its bcrypt hash is stored.
    const password = await bcrypt.hash(initialPasswordFor(email), 12);
    const data = { name, email, password, role, status: 'active', isApproved: true, isVerified: true, mustChangePassword: true };
    if (role === 'instructor') {
      let code = generateTeacherCode();
      if (await User.findOne({ teacherCode: code })) code = generateTeacherCode();
      data.teacherCode = code;
    }
    const user = await User.create(data);
    await audit(req, { action: 'user.created', targetId: String(user._id), role, email });
    res.status(201).json({ success: true, message: 'Account created. The initial password is the part of the email before @.', data: safeUser(user) });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
    next(e);
  }
});

// @route   POST /api/users/:id/reset-password
// @access  Private/Admin
router.post('/:id/reset-password', protect, authorize('admin'), async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (user.role === 'admin') return res.status(400).json({ success: false, message: 'Administrator passwords cannot be reset here.' });
    user.password = await bcrypt.hash(initialPasswordFor(user.email), 12);
    user.mustChangePassword = true;
    user.passwordChangedAt = new Date();
    await user.save();
    await audit(req, { action: 'user.password_reset', targetId: String(user._id) });
    res.json({ success: true, message: 'Password reset to the initial password (the email username). The user must change it at next sign-in.' });
  } catch (e) { next(e); }
});

// @route   POST /api/users/profile/picture   (multipart field "picture")
// @access  Private
router.post('/profile/picture', protect, parseAvatar, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Choose an image to upload.' });
    const kind = sniffImage(req.file.buffer);
    if (!kind) return res.status(400).json({ success: false, message: 'That file is not a valid JPG, PNG or WebP image.' });
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    const filename = `${user._id}-${crypto.randomBytes(8).toString('hex')}.${kind}`;
    fs.writeFileSync(path.join(avatarDir, filename), req.file.buffer, { mode: 0o644 });
    const previous = user.profilePicture;
    user.profilePicture = `/uploads/avatars/${filename}`;
    await user.save();
    removeAvatarFile(previous);
    res.json({ success: true, message: 'Profile picture saved.', data: { profilePicture: user.profilePicture } });
  } catch (e) { next(e); }
});

// @route   DELETE /api/users/profile/picture
// @access  Private
router.delete('/profile/picture', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    const previous = user.profilePicture;
    user.profilePicture = '';
    await user.save();
    removeAvatarFile(previous);
    res.json({ success: true, message: 'Profile picture removed.', data: { profilePicture: '' } });
  } catch (e) { next(e); }
});

// @route   GET /api/users/:id   (account details)
// @access  Private/Admin
router.get('/:id', protect, authorize('admin'), async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).populate('enrolledCourses', 'title');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, data: safeUser(user) });
  } catch (e) { next(e); }
});

// @route   PATCH /api/users/:id   (admin edits a student's or instructor's details)
// @access  Private/Admin
router.patch('/:id', protect, authorize('admin'), async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (user.role === 'admin') return res.status(400).json({ success: false, message: 'Administrator details are managed from their own Settings page.' });
    const b = req.body || {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (name.length < 2 || name.length > 100) return res.status(400).json({ success: false, message: 'Enter the person\u2019s full name.' });
      user.name = name;
    }
    if (b.phoneNumber !== undefined) user.phoneNumber = String(b.phoneNumber).trim().slice(0, 30);
    if (b.bio !== undefined) user.bio = String(b.bio).trim().slice(0, 500);
    if (b.email !== undefined && normalizeEmail(b.email) !== user.email) {
      const email = normalizeEmail(b.email);
      if (!isAllowedEmail(email)) return res.status(400).json({ success: false, message: emailRuleMessage() });
      if (await User.findOne({ email, _id: { $ne: String(user._id) } })) return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
      user.email = email;
    }
    await user.save();
    await audit(req, { action: 'user.updated', targetId: String(user._id) });
    res.json({ success: true, message: 'Details updated.', data: safeUser(user) });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
    next(e);
  }
});

module.exports = router;
