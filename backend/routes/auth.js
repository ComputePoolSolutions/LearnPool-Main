const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const { protect, protectAllowPasswordChange } = require('../middleware/auth');
const { normalizeEmail, isValidEmailFormat, isAutoProvisionEmail, autoProvisionDomains, initialPasswordFor, publicUser } = require('../utils/accounts');
const db = require('../db');
const { demoEnabled, demoPrivilegedAllowed, demoInstructorsAllowed, demoNameFromEmail } = require('../utils/demo');
const LmsItem = require('../models/LmsItem');
const sendEmail = require('../utils/sendEmail');
const { getOTPVerificationEmailTemplate } = require('../utils/emailTemplate');

const router = express.Router();

const getSignedJwtToken = (id, extra = {}) => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ id, ...extra }, process.env.JWT_SECRET, {
    expiresIn: '30d'
  });
};

// Generate 6-digit OTP
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

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
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date();
    await user.save();
    return res.status(200).json({ success: true, message: 'Your password has been reset. You can now sign in.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'We could not reset your password. Please try again.' });
  }
});

// Public self-registration was removed on purpose: accounts are created by an administrator
// (POST /api/users) so that roles are always assigned by an admin.

// Initial passwords are predictable (the email username), so slow down repeated wrong guesses.
const failedLogins = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000, LOGIN_MAX_FAILURES = 8;
const loginKey = (req, email) => `${req.ip || 'unknown'}|${email}`;
const loginBlocked = key => { const e = failedLogins.get(key); if (!e) return false; if (Date.now() - e.first > LOGIN_WINDOW_MS) { failedLogins.delete(key); return false; } return e.count >= LOGIN_MAX_FAILURES; };
const loginFailed = key => { const e = failedLogins.get(key); if (!e || Date.now() - e.first > LOGIN_WINDOW_MS) failedLogins.set(key, { count: 1, first: Date.now() }); else e.count += 1; };

// Just-in-time provisioning: a valid @mlrit.ac.in email whose password is the email username gets a
// Student account on first sign-in. Set AUTO_PROVISION_STUDENTS=false to turn this off.
const AUTO_PROVISION = () => process.env.AUTO_PROVISION_STUDENTS !== 'false';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function provisionStudent(email) {
  const username = initialPasswordFor(email);
  // The lock makes simultaneous first sign-ins create exactly one account; the unique-email check is the second guard.
  const release = await db.acquireLock(`provision:${email}`);
  if (!release) {
    for (let i = 0; i < 15; i++) { await sleep(200); const found = await User.findOne({ email }); if (found) return { user: found, created: false }; }
    return { user: null, created: false };
  }
  try {
    const existing = await User.findOne({ email });
    if (existing) return { user: existing, created: false };
    const user = await User.create({ name: username.toUpperCase().slice(0, 50), email, password: await bcrypt.hash(username, 12), role: 'student', status: 'active', isApproved: true, isVerified: true, mustChangePassword: true });
    await LmsItem.create({ type: 'audit-logs', owner: user._id, data: { action: 'user.auto_provisioned', targetId: String(user._id), email } }).catch(() => {});
    return { user, created: true };
  } catch (e) {
    if (e.code === 11000) return { user: await User.findOne({ email }), created: false };
    throw e;
  } finally { await release(); }
}

// Demo mode: an email that has no account yet becomes a Student with an unguessable password.
async function provisionDemoStudent(email) {
  const release = await db.acquireLock(`provision:${email}`);
  if (!release) {
    for (let i = 0; i < 15; i++) { await sleep(200); const found = await User.findOne({ email }); if (found) return { user: found, created: false }; }
    return { user: null, created: false };
  }
  try {
    const existing = await User.findOne({ email });
    if (existing) return { user: existing, created: false };
    const user = await User.create({ name: demoNameFromEmail(email), email, password: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10), role: 'student', status: 'active', isApproved: true, isVerified: true, mustChangePassword: false, isDemo: true });
    return { user, created: true };
  } catch (e) {
    if (e.code === 11000) return { user: await User.findOne({ email }), created: false };
    throw e;
  } finally { await release(); }
}

// @desc    Public sign-in configuration (lets the login page explain demo mode)
// @route   GET /api/auth/config
router.get('/config', (req, res) => res.json({ success: true, data: { demoMode: demoEnabled(), demoInstructors: demoInstructorsAllowed(), autoProvisionDomains: AUTO_PROVISION() ? autoProvisionDomains() : [] } }));

// @desc    Login user (one login for every role; the role comes from the database)
// @route   POST /api/auth/login
// @access  Public
router.post('/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please enter your email and password.' });
    }
    if (!isValidEmailFormat(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }

    const key = loginKey(req, email);
    if (loginBlocked(key)) return res.status(429).json({ success: false, message: 'Too many sign-in attempts. Please wait a few minutes and try again.' });
    let user = await User.findOne({ email });
    let provisioned = false, demoBypass = false;
    if (demoEnabled()) {
      // Demo mode: any valid email and any non-empty password. The role still comes from the database.
      if (!user) { const r = await provisionDemoStudent(email); user = r.user; provisioned = r.created; demoBypass = !!user; }
      else {
        const userRole = user.role === 'faculty' ? 'instructor' : user.role;
        if (userRole === 'student' || (userRole === 'instructor' && demoInstructorsAllowed()) || demoPrivilegedAllowed()) demoBypass = true;
      }
    }
    if (!user && !demoBypass && AUTO_PROVISION() && isAutoProvisionEmail(email) && initialPasswordFor(email).length >= 2 && password === initialPasswordFor(email)) {
      const result = await provisionStudent(email);
      user = result.user; provisioned = result.created;
    }
    // Same message for an unknown email and a wrong password, so accounts cannot be probed.
    const isMatch = demoBypass ? true : (user ? await bcrypt.compare(password, user.password) : false);
    if (!user || !isMatch) {
      loginFailed(key);
      if (demoEnabled() && user) return res.status(401).json({ success: false, message: demoInstructorsAllowed() ? 'Demo mode: administrator accounts still need their real password.' : 'Demo mode: instructor and admin accounts still need their real password.' });
      return res.status(401).json({ success: false, message: 'Incorrect email or password.' });
    }

    if (user.status === 'suspended' || user.status === 'disabled') {
      return res.status(403).json({ success: false, message: 'Your account is currently inactive. Contact the administrator.' });
    }
    const role = user.role === 'faculty' ? 'instructor' : user.role;
    if (!['student', 'instructor', 'admin'].includes(role) || (role === 'instructor' && !user.isApproved)) {
      return res.status(403).json({ success: false, message: 'Your account is not authorized.' });
    }

    failedLogins.delete(key);
    const token = getSignedJwtToken(user._id, demoBypass ? { demo: true } : {});
    res.status(200).json({ success: true, provisioned, message: demoBypass ? (provisioned ? 'Demo mode: a student account was created for you.' : 'Demo mode: signing you in.') : provisioned ? 'Welcome to LearnPool! Your student account was created. Please choose a new password.' : 'Redirecting to your dashboard.', demo: demoBypass, token, user: demoBypass ? { ...publicUser(user), mustChangePassword: false } : publicUser(user) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'We could not sign you in. Please try again.' });
  }
});

// @desc    Change own password (required on first login)
// @route   POST /api/auth/change-password
// @access  Private
router.post('/change-password', protectAllowPasswordChange, async (req, res) => {
  try {
    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    const confirmPassword = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : newPassword;
    if (!currentPassword || !newPassword) return res.status(400).json({ success: false, message: 'Enter your current password and a new password.' });
    if (newPassword !== confirmPassword) return res.status(400).json({ success: false, message: 'The new passwords do not match.' });
    if (newPassword.length < 8) return res.status(400).json({ success: false, message: 'Choose a new password with at least 8 characters.' });
    if (newPassword.length > 128) return res.status(400).json({ success: false, message: 'Choose a shorter password (up to 128 characters).' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!(await bcrypt.compare(currentPassword, user.password))) return res.status(401).json({ success: false, message: 'Your current password is incorrect.' });
    if (newPassword === currentPassword) return res.status(400).json({ success: false, message: 'Your new password must be different from the current one.' });
    if (newPassword.toLowerCase() === initialPasswordFor(user.email).toLowerCase()) return res.status(400).json({ success: false, message: 'Your new password cannot be the same as your initial password.' });

    user.password = await bcrypt.hash(newPassword, 12);
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date();
    await user.save();
    res.status(200).json({ success: true, message: 'Your password has been updated.', user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'We could not update your password. Please try again.' });
  }
});

// @desc    Verify Email
// @route   POST /api/auth/verify-email
// @access  Private (or Public if using email in body)
router.post('/verify-email', protect, async (req, res) => {
  try {
    const { otpCode } = req.body;
    const user = await User.findById(req.user.id).select('+otpCode +otpExpiry');

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
router.get('/me', protectAllowPasswordChange, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password -otpCode -otpExpiry').populate('enrolledCourses', 'title');
    if (user && req.demoSession) user.mustChangePassword = false;   // demo sessions have no initial password to change
    res.status(200).json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
