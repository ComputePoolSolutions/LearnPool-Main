const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const sendEmail = require('../utils/sendEmail');
const { getOTPVerificationEmailTemplate } = require('../utils/emailTemplate');

const router = express.Router();

const getSignedJwtToken = (id) => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: '30d'
  });
};

// Generate 6-digit OTP
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// Generate unique teacher code
const generateTeacherCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'TEA-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

// @route POST /api/auth/forgot-password
// Always return the same response so account existence is not disclosed.
router.post('/forgot-password', async (req, res) => {
  const genericMessage = 'If an account exists for that email, a password reset link will be sent.';
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(200).json({ success: true, message: genericMessage });
    const user = await User.findOne({ email }).select('+passwordResetToken +passwordResetExpiry');
    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      user.passwordResetToken = crypto.createHash('sha256').update(rawToken).digest('hex');
      user.passwordResetExpiry = new Date(Date.now() + 30 * 60 * 1000);
      await user.save();
      const clientUrl = (process.env.CLIENT_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '');
      const resetUrl = `${clientUrl}/reset-password/${rawToken}`;
      try {
        const delivery = await sendEmail({
          email: user.email,
          subject: 'Reset your LearnPool password',
          html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:32px auto;color:#1E293B"><div style="background:#1E293B;padding:26px 30px;color:white;border-radius:12px 12px 0 0"><strong style="font-size:22px">LearnPool</strong></div><div style="border:1px solid #e2e8f0;border-top:0;padding:30px;border-radius:0 0 12px 12px"><h1 style="font-size:22px;margin:0 0 12px">Reset your password</h1><p style="line-height:1.6;color:#475569">Hello ${String(user.name || 'there').replace(/[<>"'&]/g, '')}, use the button below to choose a new password. This link expires in 30 minutes.</p><p style="margin:26px 0"><a href="${resetUrl}" style="background:#2563EB;color:white;text-decoration:none;padding:12px 18px;border-radius:7px;font-weight:bold">Choose a new password</a></p><p style="font-size:13px;color:#64748b">If you didn’t request this, you can ignore this email.</p></div></div>`
        });
        if (delivery?.skipped) console.warn('Password reset email skipped because SMTP is not configured.');
      } catch (mailError) {
        console.error('Password reset email could not be sent:', mailError.message);
      }
    }
    return res.status(200).json({ success: true, message: genericMessage });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'We could not process that request. Please try again.' });
  }
});

// @route POST /api/auth/reset-password/:token
router.post('/reset-password/:token', async (req, res) => {
  try {
    const password = String(req.body.password || '');
    if (password.length < 8) return res.status(400).json({ success: false, message: 'Choose a password with at least 8 characters.' });
    const tokenHash = crypto.createHash('sha256').update(String(req.params.token || '')).digest('hex');
    const user = await User.findOne({ passwordResetToken: tokenHash, passwordResetExpiry: { $gt: new Date() } }).select('+passwordResetToken +passwordResetExpiry');
    if (!user) return res.status(400).json({ success: false, message: 'This reset link is invalid or has expired. Request a new one.' });
    user.password = await bcrypt.hash(password, 12);
    user.passwordResetToken = undefined;
    user.passwordResetExpiry = undefined;
    await user.save();
    return res.status(200).json({ success: true, message: 'Your password has been reset. You can now sign in.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'We could not reset your password. Please try again.' });
  }
});

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, teacherCode: providedTeacherCode } = req.body;
    if (!name || String(name).trim().length < 2 || !email || !/^\S+@\S+\.\S+$/.test(email) || !password || password.length < 8) {
      return res.status(400).json({ success:false, message:'Enter your name, a valid email and a password with at least 8 characters.' });
    }
    if (role && !['student','faculty','instructor'].includes(role)) return res.status(400).json({success:false,message:'Choose Student or Instructor.'});

    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ success: false, message: 'Email already exists' });
    }

    let teacherId = null;
    let generatedTeacherCode = null;

    if (role === 'student' && providedTeacherCode) {
      const teacher = await User.findOne({ teacherCode: providedTeacherCode, role: { $in: ['faculty', 'instructor'] }, isApproved: true });
      if (!teacher) {
        return res.status(404).json({ success: false, message: 'That instructor code could not be found.' });
      }
      teacherId = teacher._id;
    } else if (role === 'faculty' || role === 'instructor') {
      generatedTeacherCode = generateTeacherCode();
      // Ensure uniqueness (simple check, could be loop)
      const existingCode = await User.findOne({ teacherCode: generatedTeacherCode });
      if (existingCode) generatedTeacherCode = generateTeacherCode(); 
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const otpCode = generateOTP();
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    const userData = {
      name,
      email,
      password: hashedPassword,
      role: role === 'faculty' ? 'instructor' : (role || 'student'),
      isApproved: (role === 'faculty' || role === 'instructor') ? false : true,
      otpCode,
      otpExpiry,
    };

    if (teacherId) userData.teacher = teacherId;
    if (generatedTeacherCode) userData.teacherCode = generatedTeacherCode;

    const user = await User.create(userData);

    // Email delivery must not hold up account creation. SMTP is optional in local development.
    void sendEmail({
      email: user.email,
      subject: 'LearnPool - Email Verification OTP',
      html: getOTPVerificationEmailTemplate(otpCode, user.name),
    }).catch(error => console.warn('Verification email could not be sent:', error.message));

    const token = getSignedJwtToken(user._id);

    res.status(201).json({ success: true, token, user: { id: user._id, name: user.name, email: user.email, role: user.role, isVerified: user.isVerified } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide an email and password' });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (user.status === 'suspended' || user.status === 'disabled') return res.status(403).json({success:false,message:'This account is currently unavailable.'});

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if ((user.role === 'faculty' || user.role === 'instructor') && !user.isApproved) {
      return res.status(403).json({ success: false, message: 'Your faculty account is pending admin approval' });
    }

    const token = getSignedJwtToken(user._id);

    res.status(200).json({ success: true, token, user: { id: user._id, name: user.name, email: user.email, role: user.role, isVerified: user.isVerified } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Verify Email
// @route   POST /api/auth/verify-email
// @access  Private (or Public if using email in body)
router.post('/verify-email', protect, async (req, res) => {
  try {
    const { otpCode } = req.body;
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.isVerified) {
      return res.status(400).json({ success: false, message: 'Email is already verified' });
    }

    if (user.otpCode !== otpCode) {
      return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }

    if (new Date() > user.otpExpiry) {
      return res.status(400).json({ success: false, message: 'OTP has expired' });
    }

    user.isVerified = true;
    user.otpCode = undefined;
    user.otpExpiry = undefined;
    await user.save();

    res.status(200).json({ success: true, message: 'Email verified successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Resend OTP
// @route   POST /api/auth/resend-otp
// @access  Private
router.post('/resend-otp', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.isVerified) {
      return res.status(400).json({ success: false, message: 'Email is already verified' });
    }

    // Cooldown check
    if (user.otpExpiry && new Date() < new Date(user.otpExpiry.getTime() - 4.5 * 60 * 1000)) {
      return res.status(429).json({ success: false, message: 'Please wait before requesting a new OTP' });
    }

    const otpCode = generateOTP();
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    user.otpCode = otpCode;
    user.otpExpiry = otpExpiry;
    await user.save();

    try {
      await sendEmail({
        email: user.email,
        subject: 'LMS - Your New OTP',
        html: getOTPVerificationEmailTemplate(otpCode, user.name),
      });
    } catch (error) {
      console.error('Email send error:', error);
    }

    res.status(200).json({ success: true, message: 'OTP resent successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @desc    Get current logged in user
// @route   GET /api/auth/me
// @access  Private
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password -otpCode -otpExpiry').populate('enrolledCourses', 'title');
    res.status(200).json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
