import { Resend } from "resend";
import { logger } from "../lib/logger";
import { APP_NAME, APP_TAGLINE, DEFAULT_EMAIL_FROM } from "../lib/branding";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || DEFAULT_EMAIL_FROM;

let resend: Resend | null = null;

function getClient(): Resend | null {
  if (!RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(RESEND_API_KEY);
  return resend;
}

export function isEmailConfigured(): boolean {
  return !!RESEND_API_KEY;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  const client = getClient();
  if (!client) {
    logger.warn("[email] RESEND_API_KEY not set — email not sent to %s", opts.to);
    return false;
  }
  try {
    const { error } = await client.emails.send({
      from: EMAIL_FROM,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    });
    if (error) {
      logger.error({ error }, "[email] Resend API error");
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err }, "[email] Failed to send email");
    return false;
  }
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  name: string;
  resetUrl: string;
}): Promise<boolean> {
  return sendEmail({
    to: opts.to,
    subject: `Reset your ${APP_NAME} password`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1e293b;">
  <div style="text-align: center; margin-bottom: 24px;">
    <h2 style="margin: 0; color: #0f172a;">${APP_NAME}</h2>
    <p style="color: #64748b; font-size: 13px; margin-top: 4px;">Password Reset</p>
  </div>
  <p>Hi ${opts.name},</p>
  <p>We received a request to reset your password. Click the button below to choose a new password:</p>
  <div style="text-align: center; margin: 32px 0;">
    <a href="${opts.resetUrl}" style="display: inline-block; padding: 12px 32px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600;">Reset Password</a>
  </div>
  <p style="font-size: 13px; color: #64748b;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
  <p style="font-size: 13px; color: #64748b;">If the button doesn't work, copy and paste this URL into your browser:</p>
  <p style="font-size: 12px; color: #94a3b8; word-break: break-all;">${opts.resetUrl}</p>
  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
  <p style="font-size: 11px; color: #94a3b8; text-align: center;">${APP_NAME} — ${APP_TAGLINE}</p>
</body>
</html>`,
  });
}
