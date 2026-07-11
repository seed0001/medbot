const nodemailer = require('nodemailer');

// Any SMTP provider works: Gmail (app password), Resend, SendGrid, Mailgun, etc.
// Required env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM.
let transporter = null;

function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_PORT === '465',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  }
  return transporter;
}

function mailEnabled() {
  return Boolean(process.env.SMTP_HOST);
}

async function sendMail({ to, subject, text, html, attachments }) {
  const t = getTransporter();
  if (!t) throw new Error('Email is not configured (SMTP_HOST is not set).');
  return t.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
    attachments,
  });
}

module.exports = { sendMail, mailEnabled };
