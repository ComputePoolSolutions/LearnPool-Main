const jwt = require('jsonwebtoken');
const User = require('../models/User');

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
    if (user.status === 'suspended' || user.status === 'disabled') return res.status(403).json({ success: false, message: 'This account is currently unavailable.' });
    if (['faculty', 'instructor'].includes(user.role) && !user.isApproved) return res.status(403).json({ success: false, message: 'Your instructor account is pending admin approval.' });
    req.user = user;
    req.user.id = user._id.toString();
    User.updateOne({ _id: user._id }, { $set: { lastActive: new Date() } }).catch(() => {});
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Your sign-in has expired. Please sign in again.' });
  }
};
const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.map(canonical).includes(canonical(req.user.role))) return res.status(403).json({ success: false, message: 'You do not have permission to do that.' });
  next();
};
module.exports = { protect, authorize, canonical };
