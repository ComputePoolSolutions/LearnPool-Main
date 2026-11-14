const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
dotenv.config();
const db = require('../db');
const User = require('../models/User');

async function main() {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
    throw new Error('Set ADMIN_NAME, ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters.');
  }
  await db.connect();
  const email = ADMIN_EMAIL.trim().toLowerCase();
  const exists = await User.findOne({ email });
  if (exists) throw new Error('An account already exists for ADMIN_EMAIL.');
  const password = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await User.create({ name: ADMIN_NAME.trim(), email, password, role: 'admin', isApproved: true, isVerified: true });
  console.log('LearnPool administrator created. Remove ADMIN_PASSWORD from your environment after this one-time setup.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.disconnect());
