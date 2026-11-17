const dotenv = require('dotenv');
dotenv.config();
const db = require('../db');
const User = require('../models/User');
const credentials = require('../utils/credentials');

async function main() {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
    throw new Error('Set ADMIN_NAME, ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters.');
  }
  await db.connect();
  const email = ADMIN_EMAIL.trim().toLowerCase();
  const exists = await User.findOne({ email });
  if (exists) throw new Error('An account already exists for ADMIN_EMAIL.');
  const admin = await User.create({ name: ADMIN_NAME.trim(), email, role: 'admin', isApproved: true, isVerified: true, passwordSetupComplete: true });
  try { await credentials.setPassword(admin, ADMIN_PASSWORD); await admin.save(); }   // Firebase Authentication when configured
  catch (e) { await admin.deleteOne(); throw e; }
  console.log('LearnPool administrator created. Remove ADMIN_PASSWORD from your environment after this one-time setup.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.disconnect());
