import nodemailer from 'nodemailer';

const smtpConfigured = () => Boolean(
  process.env.SMTP_HOST
  && process.env.SMTP_PORT
  && process.env.SMTP_USER
  && process.env.SMTP_PASS
);

const createTransport = () => nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[character]));

export const sendPasswordResetEmail = async ({ email, name, resetUrl }) => {
  if (!smtpConfigured()) return { sent: false, reason: 'smtp_not_configured' };
  const safeName = escapeHtml(name || 'there');
  const safeResetUrl = escapeHtml(resetUrl);

  await createTransport().sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Reset your BDMTILES password',
    text: `Hello ${name || 'there'},\n\nUse this link to reset your BDMTILES password: ${resetUrl}\n\nThis link expires shortly. If you did not request this, you can ignore this email.`,
    html: `<p>Hello ${safeName},</p><p>Use the link below to reset your BDMTILES password:</p><p><a href="${safeResetUrl}">Reset password</a></p><p>This link expires shortly. If you did not request this, you can ignore this email.</p>`,
  });

  return { sent: true };
};
