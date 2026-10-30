const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
  const host = process.env.EMAIL_HOST || process.env.SMTP_HOST;
  const port = Number(process.env.EMAIL_PORT || process.env.SMTP_PORT || 587);
  const user = process.env.EMAIL_USER || process.env.SMTP_EMAIL;
  const pass = process.env.EMAIL_PASS || process.env.SMTP_PASSWORD;

  // Email is optional for local development. Avoid waiting on placeholder SMTP credentials.
  if (!host || !user || !pass) return { skipped: true };

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 8000,
  });
  const from = process.env.EMAIL_FROM || ((process.env.FROM_NAME || 'LearnPool') + ' <' + (process.env.FROM_EMAIL || user) + '>');
  return transporter.sendMail({ from, to: options.email, subject: options.subject, html: options.html });
};

module.exports = sendEmail;