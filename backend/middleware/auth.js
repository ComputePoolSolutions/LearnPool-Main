const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { demoEnabled } = require('../utils/demo');

const canonical = role => role === 'faculty' ? 'instructor' : role;
const protect = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Sign in to continue.' });
  try {
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ success: false, message: 'Your account could not be found.' });
    if (user.status === 'suspended' || user.status === 'disabled') return res.status(403).json({ success: false, message: 'Your account is currently inactive. Contact the administrator.' });
    if (['faculty', 'instructor'].includes(user.role) && !user.isApproved) return res.status(403).json({ success: false, message: 'Your instructor account is pending admin approval.' });
    // Accounts created by an administrator must replace their initial password first.
    // A demo-mode session (token issued without a password check) does not have an initial password to replace.
    req.demoSession = decoded.demo === true && demoEnabled();
    if (user.mustChangePassword && !req.allowPendingPasswordChange && !req.demoSession) {
      return res.status(403).json({ success: false, code: 'PASSWORD_CHANGE_REQUIRED', message: 'Please change your initial password to continue.' });
    }
    req.user = user;
    req.user.id = user._id.toString();
    User.updateOne({ _id: user._id }, { $set: { lastActive: new Date() } }).catch(() => {});
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Your sign-in has expired. Please sign in again.' });
  }
};
// Same as protect, but also lets users who still have to change their initial password through.
const protectAllowPasswordChange = (req, res, next) => { req.allowPendingPasswordChange = true; return protect(req, res, next); };
const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.map(canonical).includes(canonical(req.user.role))) return res.status(403).json({ success: false, message: 'You do not have permission to do that.' });
  next();
};
module.exports = { protect, protectAllowPasswordChange, authorize, canonical };
