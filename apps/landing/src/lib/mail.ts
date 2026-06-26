import nodemailer from "nodemailer";

// Google Workspace SMTP transport. Uses App Password auth (2FA required
// on the sending account). Port 587 with STARTTLS — Vercel allows this,
// only port 25 (unauthenticated relay) is blocked.
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false, // STARTTLS upgrades the connection after EHLO
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM = process.env.SMTP_FROM || "Crivacy <auth@crivacy.io>";
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://crivacy.io";

// Plain, no-frills confirmation email. Kept deliberately simple:
//   - Plain text part so spam filters see a text alternative
//   - HTML part with inline styles only (no <style> blocks — Gmail etc.
//     strip them unpredictably)
//   - No tracking pixels, no marketing fluff — this is a transactional
//     mail so we keep it clean to stay out of Promotions / Spam
export async function sendConfirmation(email: string, token: string) {
  const link = `${SITE_URL}/api/notify/confirm?token=${encodeURIComponent(token)}`;

  const text = [
    "Confirm your Crivacy waitlist signup",
    "",
    "Click the link below to confirm your email address and join the Crivacy early-access waitlist:",
    link,
    "",
    "If you didn't sign up, you can safely ignore this email.",
    "",
    "Crivacy",
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0a0a0f;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#e8e8ed;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0a0a0f;padding:40px 20px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:#12121a;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:40px;">
            <tr>
              <td>
                <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#e8e8ed;letter-spacing:-0.01em;">Confirm your email</h1>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#8a8a9a;">
                  Thanks for joining the Crivacy waitlist. Click the button below to confirm your address and secure your spot for early access.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="background:#63dcbe;border-radius:8px;">
                      <a href="${link}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#0a0a0f;text-decoration:none;">
                        Confirm email
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#5a5a6e;">
                  Or paste this link into your browser:<br>
                  <span style="color:#8a8a9a;word-break:break-all;">${link}</span>
                </p>
                <hr style="border:0;border-top:1px solid rgba(255,255,255,0.06);margin:32px 0;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#5a5a6e;">
                  If you didn't sign up for the Crivacy waitlist, you can safely ignore this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: "Confirm your Crivacy waitlist signup",
    text,
    html,
  });
}
