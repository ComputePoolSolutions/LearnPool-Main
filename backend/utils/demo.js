// Demo login mode: lets people try LearnPool with any email and password.
// It can NEVER be active when NODE_ENV=production, whatever the flag says.
const demoEnabled = () => process.env.DEMO_LOGIN_MODE === 'true' && process.env.NODE_ENV !== 'production';
// Off by default: instructor and admin accounts keep requiring their real password even in demo mode.
const demoPrivilegedAllowed = () => demoEnabled() && process.env.DEMO_ALLOW_PRIVILEGED_ACCOUNTS === 'true';
const demoNameFromEmail = email => {
  const local = String(email).split('@')[0].replace(/[._+\-]+/g, ' ').replace(/\d+/g, ' ').trim();
  const name = local.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 50);
  return name.length >= 2 ? name : 'Demo Learner';
};
// In demo mode instructors may sign in with any password (admins never can). This is ON by default
// while demo mode is on; set DEMO_ALLOW_INSTRUCTORS=false to make instructors use their real password.
const demoInstructorsAllowed = () => demoEnabled() && (process.env.DEMO_ALLOW_INSTRUCTORS !== 'false' || demoPrivilegedAllowed());
const DEMO_PASSWORD_MESSAGE = 'You are signed in with the temporary demo password, which is not a real password. Use Settings \u2192 Set Your Password to create a permanent one.';
module.exports = { demoEnabled, demoPrivilegedAllowed, demoInstructorsAllowed, demoNameFromEmail, DEMO_PASSWORD_MESSAGE };
