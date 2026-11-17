const mongoose = require('../db');
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  // bcrypt hash, only for the "local" provider. With Firebase Authentication no password is stored here.
  password: { type: String, minlength: 8 },
  credentialProvider: { type: String, enum: ['local', 'firebase'] },
  // true once the person has chosen their own permanent password (unset on older accounts: see utils/credentials.js)
  passwordSetupComplete: { type: Boolean },
  role: { type: String, enum: ['student', 'faculty', 'instructor', 'admin'], default: 'student' },
  status: { type: String, enum: ['active', 'suspended', 'disabled'], default: 'active' },
  isApproved: { type: Boolean, default: true },
  teacherCode: { type: String, unique: true, sparse: true },
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  profilePicture: { type: String, default: '' },
  phoneNumber: { type: String, default: '' },
  bio: { type: String, default: '', maxlength: 500 },
  skills: [{ type: String }],
  interests: [{ type: String }],
  enrolledCourses: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Course' }],
  points: { type: Number, default: 0, min: 0 },
  studySeconds: { type: Number, default: 0, min: 0 },
  preferences: { type: mongoose.Schema.Types.Mixed, default: { emailNotifications:true, weeklySummary:false } },
  isVerified: { type: Boolean, default: false },
  mustChangePassword: { type: Boolean, default: false },
  isDemo: { type: Boolean, default: false },
  passwordChangedAt: { type: Date },
  otpCode: { type: String, select: false },
  otpExpiry: { type: Date, select: false },
  passwordResetToken: { type: String, select: false },
  passwordResetExpiry: { type: Date, select: false },
  lastActive: { type: Date, default: Date.now }
}, { timestamps: true });
userSchema.index({ role: 1, status: 1 });
module.exports = mongoose.model('User', userSchema);
