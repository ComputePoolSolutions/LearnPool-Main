const INSTITUTIONAL_DOMAIN = '@mlrit.ac.in';
const ASSIGNABLE_ROLES = ['student', 'instructor'];

const normalizeEmail = value => String(value || '').trim().toLowerCase();
const isValidEmailFormat = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Domain rules come from the environment. "*" means any valid email address.
const domainList = (value, fallback) => String(value === undefined || value === '' ? fallback : value).split(',').map(s => s.trim().toLowerCase()).filter(Boolean).map(d => (d === '*' ? '*' : d.startsWith('@') ? d : `@${d}`));
// Who may hold a Student or Instructor account (default: any valid email).
const allowedDomains = () => domainList(process.env.ALLOWED_EMAIL_DOMAINS, '*');
// Whose first sign-in may create a Student account automatically (default: only @mlrit.ac.in).
const autoProvisionDomains = () => domainList(process.env.AUTO_PROVISION_DOMAINS, INSTITUTIONAL_DOMAIN);
// Exact domain match: "x@mlrit.ac.in" yes, "x@mlrit.ac.in.evil.com" / "x@sub.mlrit.ac.in" no.
const matchesDomains = (email, list) => isValidEmailFormat(email) && list.some(d => d === '*' || (email.endsWith(d) && email.indexOf('@') === email.length - d.length && email.indexOf('@') > 0));
const isAllowedEmail = email => matchesDomains(email, allowedDomains());
const isAutoProvisionEmail = email => matchesDomains(email, autoProvisionDomains());
const emailRuleMessage = () => { const list = allowedDomains(); return list.includes('*') ? 'Enter a valid email address.' : `Use an email address ending in ${list.join(' or ')}.`; };
// Kept for older callers.
const isInstitutionalEmail = isAutoProvisionEmail;

// Initial password = the part of the email before "@".
const initialPasswordFor = email => String(email).split('@')[0];

const generateTeacherCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'TEA-';
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
};

// Fields that are safe to send to the browser.
const publicUser = user => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role === 'faculty' ? 'instructor' : user.role,
  status: user.status,
  isVerified: user.isVerified,
  profilePicture: user.profilePicture || '',
  mustChangePassword: !!user.mustChangePassword,
});

module.exports = { INSTITUTIONAL_DOMAIN, ASSIGNABLE_ROLES, normalizeEmail, isValidEmailFormat, isInstitutionalEmail, isAllowedEmail, isAutoProvisionEmail, allowedDomains, autoProvisionDomains, emailRuleMessage, initialPasswordFor, generateTeacherCode, publicUser };
