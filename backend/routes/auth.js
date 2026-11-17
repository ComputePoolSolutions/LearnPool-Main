const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const { protect, protectAllowPasswordChange } = require('../middleware/auth');
const { normalizeEmail, isValidEmailFormat, isAutoProvisionEmail, autoProvisionDomains, initialPasswordFor, publicUser } = require('../utils/accounts');
const db = require('../db');
const { demoEnabled, demoPrivilegedAllowed, demoInstructorsAllowed, demoNameFromEmail, DEMO_PASSWORD_MESSAGE } = require('../utils/demo');
const credentials = require('../utils/credentials');
// 'set' = onboarding session with no permanent password yet (create one without a current password);
// 'change' = a verified password exists (changing it needs the current one).
const passwordModeFor = (user, demoSession) => (demoSession ? 'set' : 'change');
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
    await credentials.setPassword(user, password);
    user.passwordSetupComplete = true;
    user.passwordResetToken = undefined;
    user.passwordResetExpiry = undefined;
    user.isDemo = false;   // an emailed reset proves the address and creates a real password
    user.mustChangePassword = false;
    await user.save();
    return res.status(200).json({ success: true, message: 'Your password has been reset. You can now sign in.' });
  } catch (err) {
    if (err && err.expose) return res.status(err.status).json({ success: false, message: err.message });
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

// Just-in-time provisioning: an email on one of the AUTO_PROVISION_DOMAINS whose password is the email username gets a
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
    const user = await User.create({ name: username.toUpperCase().slice(0, 50), email, role: 'student', status: 'active', isApproved: true, isVerified: true, mustChangePassword: true, passwordSetupComplete: false });
    try { await credentials.setPassword(user, username); await user.save(); }
    catch (e) { await user.deleteOne(); throw e; }
    await LmsItem.create({ type: 'audit-logs', owner: user._id, data: { action: 'user.auto_provisioned', targetId: String(user._id), email } }).catch(() => {});
    return { user, created: true };
  } catch (e) {
    if (e.code === 11000) return { user: await User.findOne({ email }), created: false };
    throw e;
  } finally { await release(); }
}

// Demo / onboarding: an email that has no account yet becomes a Student. No password exists until the person sets one.
async function provisionDemoStudent(email) {
  const release = await db.acquireLock(`provision:${email}`);
  if (!release) {
    for (let i = 0; i < 15; i++) { await sleep(200); const found = await User.findOne({ email }); if (found) return { user: found, created: false }; }
    return { user: null, created: false };
  }
  try {
    const existing = await User.findOne({ email });
    if (existing) return { user: existing, created: false };
    const user = await User.create({ name: demoNameFromEmail(email), email, role: 'student', status: 'active', isApproved: true, isVerified: true, mustChangePassword: false, passwordSetupComplete: false, isDemo: true });
    return { user, created: true };
  } catch (e) {
    if (e.code === 11000) return { user: await User.findOne({ email }), created: false };
    throw e;
  } finally { await release(); }
}

// @desc    Public sign-in configuration (lets the login page explain demo mode)
// @route   GET /api/auth/config
router.get('/config', (req, res) => res.json({ success: true, data: { demoMode: demoEnabled(), demoInstructors: demoInstructorsAllowed(), authProvider: credentials.providerName(), autoProvisionDomains: AUTO_PROVISION() ? autoProvisionDomains() : [] } }));

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

    const demo = demoEnabled();
    let user = await User.findOne({ email });
    let provisioned = false, demoBypass = false, verdict = null;

    if (!user && demo) {
      // Onboarding: a new email becomes a Student. Roles are never granted here; only an admin can change them.
      const r = await provisionDemoStudent(email);
      user = r.user; provisioned = r.created; demoBypass = !!user;
    } else if (!user && AUTO_PROVISION() && isAutoProvisionEmail(email) && initialPasswordFor(email).length >= 2 && password === initialPasswordFor(email)) {
      const r = await provisionStudent(email);
      user = r.user; provisioned = r.created;
    }

    if (user && !demoBypass) {
      const role = user.role === 'faculty' ? 'instructor' : user.role;
      // Onboarding access (any password) exists ONLY for accounts that have no permanent password yet, and never for admins.
      const onboarding = demo && !credentials.passwordSetupComplete(user)
        && (role === 'student' || (role === 'instructor' && demoInstructorsAllowed()) || demoPrivilegedAllowed());
      if (onboarding && !credentials.hasCredential(user)) demoBypass = true;
      else {
        verdict = await credentials.verify(user, password);
        // An onboarding account whose administrator-issued initial password is typed correctly gets a normal session;
        // anything else opens an onboarding session.
        if (onboarding) demoBypass = !verdict.ok;
      }
    }

    if (!user || (!demoBypass && !(verdict && verdict.ok))) {
      loginFailed(key);
      if (verdict && verdict.reason === 'throttled') return res.status(429).json({ success: false, message: 'Too many sign-in attempts. Please wait a few minutes and try again.' });
      if (verdict && verdict.reason === 'disabled') return res.status(403).json({ success: false, message: 'Your account is currently inactive. Contact the administrator.' });
      if (demo && user && user.role === 'admin') return res.status(401).json({ success: false, message: 'Demo mode: administrator accounts still need their real password.' });
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
    res.status(200).json({
      success: true, provisioned, demo: demoBypass, token,
      message: demoBypass ? (provisioned ? 'Demo mode: a student account was created for you.' : 'Demo mode: signing you in.') : provisioned ? 'Welcome to LearnPool! Your student account was created. Please choose a new password.' : 'Redirecting to your dashboard.',
      user: { ...publicUser(user), ...(demoBypass ? { mustChangePassword: false } : {}), passwordMode: passwordModeFor(user, demoBypass), passwordSetupComplete: credentials.passwordSetupComplete(user) },
    });
  } catch (err) {
    if (err && err.expose) return res.status(err.status).json({ success: false, message: err.message });
    res.status(500).json({ success: false, message: 'We could not sign you in. Please try again.' });
  }
});

const strongEnough = (password, user) => {
  if (password.length < 8) return 'Choose a password with at least 8 characters.';
  if (password.length > 128) return 'Choose a shorter password (up to 128 characters).';
  if (password.toLowerCase() === initialPasswordFor(user.email).toLowerCase()) return 'Your password cannot be the same as your email username.';
  return '';
};

// @desc    Create the first permanent password (onboarding sessions only; no current password exists to check)
// @route   POST /api/auth/set-password
// @access  Private (onboarding / demo session)
router.post('/set-password', protect, async (req, res) => {
  try {
    if (!req.demoSession) return res.status(403).json({ success: false, code: 'NOT_ONBOARDING', message: 'Your account already has a password. Use Change password and enter your current password.' });
    const account = await User.findById(req.user.id);
    if (!account) return res.status(404).json({ success: false, message: 'User not found.' });
    if (credentials.passwordSetupComplete(account)) return res.status(409).json({ success: false, message: 'This account already has a permanent password. Sign in with it to change it.' });
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    const confirmPassword = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';
    if (!newPassword || !confirmPassword) return res.status(400).json({ success: false, message: 'Enter and confirm your new password.' });
    if (newPassword !== confirmPassword) return res.status(400).json({ success: false, message: 'The passwords do not match.' });
    const weak = strongEnough(newPassword, account);
    if (weak) return res.status(400).json({ success: false, message: weak });

    await credentials.setPassword(account, newPassword);   // Firebase Authentication (or a bcrypt hash in local mode)
    account.passwordSetupComplete = true;
    account.isDemo = false;
    account.mustChangePassword = false;
    await account.save();
    await LmsItem.create({ type: 'audit-logs', owner: account._id, data: { action: 'password.set', targetId: String(account._id) } }).catch(() => {});
    // The onboarding session is replaced by a normal one.
    res.status(200).json({ success: true, message: 'Your permanent password is set. Use it the next time you sign in.', token: getSignedJwtToken(account._id), user: { ...publicUser(account), passwordMode: 'change', passwordSetupComplete: true } });
  } catch (err) {
    if (err && err.expose) return res.status(err.status).json({ success: false, message: err.message });
    res.status(500).json({ success: false, message: 'We could not save your password. Please try again.' });
  }
});

// @desc    Change an existing password (the current one is re-checked, with Firebase when it is the provider)
// @route   POST /api/auth/change-password
// @access  Private
router.post('/change-password', protectAllowPasswordChange, async (req, res) => {
  try {
    const account = await User.findById(req.user.id);
    if (!account) return res.status(404).json({ success: false, message: 'User not found.' });
    if (req.demoSession) return res.status(409).json({ success: false, code: 'SET_PASSWORD_FIRST', message: DEMO_PASSWORD_MESSAGE });
    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    const confirmPassword = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : newPassword;
    if (!currentPassword || !newPassword) return res.status(400).json({ success: false, message: 'Enter your current password and a new password.' });
    if (newPassword !== confirmPassword) return res.status(400).json({ success: false, message: 'The new passwords do not match.' });
    const weak = strongEnough(newPassword, account);
    if (weak) return res.status(400).json({ success: false, message: weak.replace('Your password', 'Your new password') });
    if (!credentials.hasCredential(account)) return res.status(409).json({ success: false, message: 'This account has no password yet. Sign in and use Set Your Password in Settings.' });

    const check = await credentials.verify(account, currentPassword);
    if (!check.ok) {
      if (check.reason === 'throttled') return res.status(429).json({ success: false, message: 'Too many attempts. Please wait a few minutes and try again.' });
      return res.status(401).json({ success: false, message: 'Your current password is incorrect.' });
    }
    if (newPassword === currentPassword) return res.status(400).json({ success: false, message: 'Your new password must be different from the current one.' });

    await credentials.setPassword(account, newPassword);
    account.mustChangePassword = false;
    account.passwordSetupComplete = true;
    account.isDemo = false;
    await account.save();
    res.status(200).json({ success: true, message: 'Your password has been updated.', user: { ...publicUser(account), passwordMode: 'change', passwordSetupComplete: true } });
  } catch (err) {
    if (err && err.expose) return res.status(err.status).json({ success: false, message: err.message });
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
    if (user) { user.passwordMode = passwordModeFor(user, req.demoSession); user.passwordSetupComplete = credentials.passwordSetupComplete(user); }
    res.status(200).json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
