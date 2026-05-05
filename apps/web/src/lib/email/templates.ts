/**
 * Email HTML templates — server-side only.
 *
 * Each template returns a `{ subject, html, text }` tuple:
 *   - `html` — rendered in an email client as HTML.
 *   - `text` — plaintext fallback, never parsed as HTML.
 *   - `subject` — header field, treated as plaintext by clients.
 *
 * Security rule — MUST be followed for every new template:
 *
 *   Any template-string interpolation inside the `html` body that
 *   carries user- or firm- or admin- supplied data MUST be wrapped
 *   in {@link escapeHtml}. Our zod email regex permits RFC 5322
 *   quoted local-parts, so an email-derived `displayName` can carry
 *   arbitrary HTML bytes; ticket bodies, firm names, device-name
 *   strings and timestamps from request headers are all equally
 *   attacker-controlled. The `text` and `subject` fields can stay
 *   raw — email clients don't parse them as HTML.
 *
 *   Interpolations of server-generated values (reset codes, URLs
 *   built from `NEXT_PUBLIC_APP_URL`, enum-driven spec strings)
 *   do not need escaping but are still safe to escape defensively.
 *
 * @module
 */

import { getAppUrl } from '@/lib/env/app-url';

/* ---------- Types ---------- */

export interface EmailContent {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/* ---------- Shared layout ---------- */

const BRAND_COLOR = '#10b981';
const BG_COLOR = '#0a0a0b';
const SURFACE_COLOR = '#111113';
const FG_COLOR = '#f5f5f7';
const MUTED_COLOR = '#7a7a82';

function layout(title: string, body: string): string {
  // Escape the title defensively — some callers splice user-chosen
  // firm / ticket names into it. An unescaped `</title><script>`
  // payload would close the title tag early in email clients that
  // parse it as HTML; we do not trust the caller to remember the
  // shell is an HTML context.
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background-color:${BG_COLOR};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG_COLOR};">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:${SURFACE_COLOR};border-radius:12px;border:1px solid #1f1f23;">
          <!-- Logo -->
          <tr>
            <td align="center" style="padding:32px 32px 0;">
              <span style="font-size:24px;font-weight:700;color:${FG_COLOR};letter-spacing:-0.5px;">Crivacy</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:24px 32px 32px;color:${FG_COLOR};font-size:15px;line-height:1.6;">
              ${body}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:16px 32px 24px;border-top:1px solid #1f1f23;">
              <p style="margin:0;font-size:12px;color:${MUTED_COLOR};text-align:center;">
                Crivacy — FHE-powered re-usable KYC<br>
                <a href="https://crivacy.io" style="color:${MUTED_COLOR};text-decoration:underline;">crivacy.io</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Safe button helper: whitelists `https:` + `mailto:` schemes (reject
 * `javascript:`, `data:`, any other protocol), attribute-escapes the
 * href, HTML-escapes the visible text. Callers historically pass
 * server-built URLs, but hardening now closes the AUD-X-XSS-001 gap
 * before any future caller drifts into user-controlled input.
 */
function button(text: string, url: string): string {
  const safeUrl = sanitizeEmailUrl(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
  <tr>
    <td align="center" style="background-color:${BRAND_COLOR};border-radius:8px;">
      <a href="${safeUrl}" target="_blank" style="display:inline-block;padding:12px 32px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
        ${escapeHtml(text)}
      </a>
    </td>
  </tr>
</table>`;
}

/**
 * Validate + escape a URL for use inside an email `<a href="...">`
 * attribute. Rejects non-whitelisted protocols by returning a safe
 * placeholder (`#`) — the visual button still renders, the click
 * simply no-ops instead of triggering `javascript:` or `data:` on an
 * Outlook-style client that follows the scheme.
 */
function sanitizeEmailUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '#';
  }
  // Whitelist benign protocols. `http:` is kept so local-dev emails
  // (NEXT_PUBLIC_APP_URL=http://localhost:3001) still render clickable
  // CTAs. Prod deployments use `https:` via that same env. The ones
  // we care about blocking — `javascript:`, `data:`, `file:`, etc. —
  // are the only ones that can execute inside an email client.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'mailto:') {
    return '#';
  }
  // attribute-escape: double-quote-safe (`"` in URLs is RFC-invalid
  // anyway, but defence-in-depth against caller-controlled garbage).
  return parsed.toString().replace(/"/g, '&quot;');
}

/* ---------- Helpers ---------- */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------- Templates ---------- */

export function verificationEmail(params: {
  displayName: string;
  verifyUrl: string;
  expiresInHours: number;
}): EmailContent;
export function verificationEmail(params: {
  displayName: string;
  code: string;
  expiresInMinutes: number;
}): EmailContent;
export function verificationEmail(params: {
  displayName: string;
  verifyUrl?: string;
  expiresInHours?: number;
  code?: string;
  expiresInMinutes?: number;
}): EmailContent {
  // Every user-controlled string is escaped before landing in the
  // HTML body. `displayName` is derived from `email.split('@')[0]`
  // upstream; zod's email regex allows quoted local-parts (RFC 5322)
  // which can carry arbitrary characters — without escaping, a
  // crafted registration would yield a reflective XSS every time
  // the victim opened a verify / reset email.
  const safeName = escapeHtml(params.displayName);

  // Code-based verification (Phase 4)
  if (params.code !== undefined) {
    const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">Verify your email</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 24px;">Enter this verification code to activate your Crivacy account:</p>
    <div style="margin:0 0 24px;padding:24px 16px;background-color:#0a0a0b;border-radius:8px;border:1px solid #1f1f23;text-align:center;">
      <span style="display:inline-block;font-size:32px;font-weight:700;letter-spacing:10px;font-family:'Courier New',Courier,monospace;color:${BRAND_COLOR};white-space:nowrap;">${params.code}</span>
    </div>
    <p style="margin:0;font-size:13px;color:${MUTED_COLOR};">
      This code expires in ${params.expiresInMinutes} minutes. If you didn't create an account, you can safely ignore this email.
    </p>`;

    return {
      subject: 'Your verification code — Crivacy',
      html: layout('Verify your email', body),
      text: `Hi ${params.displayName},\n\nYour Crivacy verification code is: ${params.code}\n\nThis code expires in ${params.expiresInMinutes} minutes.\n\nIf you didn't create a Crivacy account, you can safely ignore this email.`,
    };
  }

  // Legacy link-based verification (kept for backwards compat during migration)
  const safeUrl = escapeHtml(params.verifyUrl!);
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">Verify your email</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 8px;">Click the button below to verify your email address and activate your Crivacy account.</p>
    ${button('Verify Email', params.verifyUrl!)}
    <p style="margin:0;font-size:13px;color:${MUTED_COLOR};">
      This link expires in ${params.expiresInHours} hours. If you didn't create an account, you can safely ignore this email.
    </p>
    <p style="margin:16px 0 0;font-size:13px;color:${MUTED_COLOR};word-break:break-all;">
      Or copy this link: ${safeUrl}
    </p>`;

  return {
    subject: 'Verify your email — Crivacy',
    html: layout('Verify your email', body),
    text: `Hi ${params.displayName},\n\nVerify your email by visiting: ${params.verifyUrl}\n\nThis link expires in ${params.expiresInHours} hours.\n\nIf you didn't create a Crivacy account, you can safely ignore this email.`,
  };
}

export function passwordResetEmail(params: {
  displayName: string;
  resetUrl: string;
  expiresInMinutes: number;
}): EmailContent;
export function passwordResetEmail(params: {
  displayName: string;
  code: string;
  expiresInMinutes: number;
}): EmailContent;
export function passwordResetEmail(params: {
  displayName: string;
  resetUrl?: string;
  code?: string;
  expiresInMinutes: number;
}): EmailContent {
  const safeName = escapeHtml(params.displayName);

  // Code-based reset (Phase 4)
  if (params.code !== undefined) {
    // Use CSS letter-spacing on the bare digits so the code renders
    // on a single line. The old `split('').join(' &nbsp; ')` trick
    // combined with letter-spacing:8px made the string wider than
    // the email container and it wrapped mid-code in most clients.
    const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">Reset your password</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 24px;">Enter this code to reset your password:</p>
    <div style="margin:0 0 24px;padding:24px 16px;background-color:#0a0a0b;border-radius:8px;border:1px solid #1f1f23;text-align:center;">
      <span style="display:inline-block;font-size:32px;font-weight:700;letter-spacing:10px;font-family:'Courier New',Courier,monospace;color:${BRAND_COLOR};white-space:nowrap;">${params.code}</span>
    </div>
    <p style="margin:0;font-size:13px;color:${MUTED_COLOR};">
      This code expires in ${params.expiresInMinutes} minutes. If you didn't request this, your password is still safe — no action needed.
    </p>`;

    return {
      subject: 'Your password reset code — Crivacy',
      html: layout('Reset your password', body),
      text: `Hi ${params.displayName},\n\nYour Crivacy password reset code is: ${params.code}\n\nThis code expires in ${params.expiresInMinutes} minutes.\n\nIf you didn't request this, your password is still safe.`,
    };
  }

  // Legacy link-based reset (kept for backwards compat)
  const safeUrl = escapeHtml(params.resetUrl!);
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">Reset your password</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 8px;">We received a request to reset your password. Click the button below to choose a new password.</p>
    ${button('Reset Password', params.resetUrl!)}
    <p style="margin:0;font-size:13px;color:${MUTED_COLOR};">
      This link expires in ${params.expiresInMinutes} minutes. If you didn't request this, your password is still safe — no action needed.
    </p>
    <p style="margin:16px 0 0;font-size:13px;color:${MUTED_COLOR};word-break:break-all;">
      Or copy this link: ${safeUrl}
    </p>`;

  return {
    subject: 'Reset your password — Crivacy',
    html: layout('Reset your password', body),
    text: `Hi ${params.displayName},\n\nReset your password by visiting: ${params.resetUrl}\n\nThis link expires in ${params.expiresInMinutes} minutes.\n\nIf you didn't request this, your password is still safe.`,
  };
}

/**
 * Notification sent to an existing account holder when a registration
 * attempt is made using their email address. Part of the anti-enumeration
 * register flow: the register endpoint always returns a generic 200 to
 * the caller, and if the email was already on file we email the real
 * owner instead of silently dropping the request. Closes the social-
 * engineering / account-hijack vector where an attacker probes an email,
 * gets a generic success, then phishes the victim with "please confirm
 * your new account" follow-ups.
 */
export function registrationAttemptedEmail(params: {
  displayName: string;
  loginUrl: string;
}): EmailContent {
  const safeName = escapeHtml(params.displayName);
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">Registration attempt with your email</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 8px;">Someone just tried to create a new Crivacy account using this email address. Your existing account is safe and no changes were made.</p>
    <p style="margin:0 0 16px;">If this was you and you forgot you had an account, sign in below. If this wasn't you, you can ignore this message — no new account was created.</p>
    ${button('Sign In', params.loginUrl)}
    <p style="margin:16px 0 0;font-size:13px;color:${MUTED_COLOR};">
      If you didn't ask for a new account and keep receiving these messages, please contact
      <a href="mailto:support@crivacy.io" style="color:${BRAND_COLOR};text-decoration:underline;">support@crivacy.io</a>.
    </p>`;

  return {
    subject: 'Registration attempt with your Crivacy email',
    html: layout('Registration attempt', body),
    text: `Hi ${params.displayName},\n\nSomeone tried to create a new Crivacy account using this email address. Your existing account is safe.\n\nIf this was you: sign in at ${params.loginUrl}\nIf this wasn't you: ignore this message — no new account was created.`,
  };
}

/**
 * Notification sent to an existing account holder when *another*
 * logged-in user attempts to change their own account's email to
 * this address. Counterpart of {@link registrationAttemptedEmail}
 * for the in-product email-change flow.
 *
 * Closes the authenticated enumeration oracle the change-email
 * endpoint used to present — the API now always responds with a
 * generic "verification code sent" shape regardless of whether the
 * target address is already attached to another customer. The real
 * account holder hears about the attempt out-of-band through this
 * template so a takeover or social-engineering probe still leaves
 * a trace in the target inbox.
 */
export function emailChangeAttemptedEmail(params: {
  displayName: string;
  loginUrl: string;
}): EmailContent {
  const safeName = escapeHtml(params.displayName);
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">Someone tried to move another account to your email</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 8px;">A different Crivacy user just tried to change the email on their account to yours. Your account is safe and no changes were made.</p>
    <p style="margin:0 0 16px;">No action is required. If you want to review your sessions or change your own security settings, sign in below.</p>
    ${button('Sign In', params.loginUrl)}
    <p style="margin:16px 0 0;font-size:13px;color:${MUTED_COLOR};">
      If you keep receiving these messages, please contact
      <a href="mailto:support@crivacy.io" style="color:${BRAND_COLOR};text-decoration:underline;">support@crivacy.io</a>.
    </p>`;
  return {
    subject: 'Someone tried to move another Crivacy account to your email',
    html: layout('Email-change attempt detected', body),
    text: `Hi ${params.displayName},\n\nA different Crivacy user just tried to change the email on their account to yours. Your account is safe — no changes were made and no action is needed.\n\nSign in: ${params.loginUrl}`,
  };
}

/**
 * Notification sent whenever the account's password hash is rotated
 * through a user-initiated path: change-password (logged-in),
 * set-password (wallet-only user adding a password), or reset-
 * password (forgot-password flow). Purpose is the same as the "new
 * sign-in" alert — surface the change in the account holder's inbox
 * so a compromise that pivoted through password rotation leaves a
 * visible trace. Industry standard (Gmail, GitHub, Stripe).
 *
 * The copy deliberately never includes the new password, the old
 * password hash, or any reset token — just "your password was
 * changed at this time" and a prominent "not you?" affordance.
 */
export function passwordChangedEmail(params: {
  displayName: string;
  timestamp: string;
  ipAddress: string;
  /** Absolute URL pointing at the audience-appropriate security
   *  settings screen so the user can rotate again or review sessions. */
  securityUrl: string;
  /** Short descriptor shown in the body — "changed", "set for the
   *  first time", "reset via forgot-password". */
  reason: 'changed' | 'set' | 'reset';
}): EmailContent {
  const safeName = escapeHtml(params.displayName);
  const safeTime = escapeHtml(params.timestamp);
  const safeIp = escapeHtml(params.ipAddress);
  const reasonText =
    params.reason === 'set'
      ? 'A password was set on your Crivacy account for the first time.'
      : params.reason === 'reset'
        ? 'Your Crivacy password was reset through the forgot-password flow.'
        : 'Your Crivacy password was changed.';
  const subjectText =
    params.reason === 'set'
      ? 'A password was set on your Crivacy account'
      : params.reason === 'reset'
        ? 'Your Crivacy password has been reset'
        : 'Your Crivacy password has been changed';
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">${subjectText}</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 16px;">${reasonText}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:14px;color:${FG_COLOR};">
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">Time</td><td>${safeTime}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">IP</td><td>${safeIp}</td></tr>
    </table>
    <p style="margin:0 0 8px;">If this was you, no action is needed. If you don't recognise this change, secure your account immediately — every other active session has already been signed out.</p>
    ${button('Review Security Settings', params.securityUrl)}
    <p style="margin:16px 0 0;font-size:13px;color:${MUTED_COLOR};">
      If you didn't ask for this and can't sign in, contact
      <a href="mailto:support@crivacy.io" style="color:${BRAND_COLOR};text-decoration:underline;">support@crivacy.io</a>.
    </p>`;
  return {
    subject: subjectText,
    html: layout(subjectText, body),
    text: `Hi ${params.displayName},\n\n${reasonText}\n\nTime: ${params.timestamp}\nIP: ${params.ipAddress}\n\nIf this wasn't you, secure your account: ${params.securityUrl}`,
  };
}

export function welcomeEmail(params: {
  displayName: string;
  loginUrl: string;
}): EmailContent {
  const safeName = escapeHtml(params.displayName);
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">Welcome to Crivacy</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 8px;">Your email has been verified. You can now sign in and start your KYC verification.</p>
    ${button('Sign In', params.loginUrl)}
    <p style="margin:0;font-size:13px;color:${MUTED_COLOR};">
      Verify once, use everywhere — your on-chain KYC credential is portable and reusable across all Crivacy partner platforms.
    </p>`;

  return {
    subject: 'Welcome to Crivacy',
    html: layout('Welcome to Crivacy', body),
    text: `Hi ${params.displayName},\n\nYour email has been verified. Sign in at: ${params.loginUrl}\n\nVerify once, use everywhere.`,
  };
}

/**
 * Onboarding invitation for a brand-new firm user. Carries the
 * single-use acceptance link embedded in the welcome CTA. Rendered
 * from the admin `firm.created` flow and from teammate invites.
 *
 * The `recipientEmail` is included in the body so the recipient can
 * double-check the link was meant for them (common anti-phishing
 * affordance in B2B onboarding emails).
 */
export function firmUserInviteEmail(params: {
  readonly firmName: string;
  readonly recipientEmail: string;
  readonly acceptUrl: string;
  readonly expiresInHours: number;
}): EmailContent {
  const safeFirm = escapeHtml(params.firmName);
  const safeEmail = escapeHtml(params.recipientEmail);

  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">You're invited to Crivacy</h2>
    <p style="margin:0 0 12px;">You've been added as the owner of <strong>${safeFirm}</strong> on Crivacy.</p>
    <p style="margin:0 0 12px;color:${MUTED_COLOR};font-size:14px;">This invitation was sent to <strong style="color:${FG_COLOR};">${safeEmail}</strong>.</p>
    <p style="margin:0 0 16px;">Click below to set your password and enable two-factor authentication.</p>
    ${button('Accept invite', params.acceptUrl)}
    <p style="margin:24px 0 0;font-size:13px;color:${MUTED_COLOR};">
      This link expires in ${String(params.expiresInHours)} hours and can only be used once.
      If it wasn't you, ignore this email or contact
      <a href="mailto:support@crivacy.io" style="color:${BRAND_COLOR};text-decoration:underline;">support@crivacy.io</a>.
    </p>`;

  return {
    subject: `You're invited to ${params.firmName} on Crivacy`,
    html: layout(`Welcome to ${params.firmName}`, body),
    text: `You've been invited to ${params.firmName} on Crivacy.\n\nAccept the invite and set up your account:\n${params.acceptUrl}\n\nThis link expires in ${String(params.expiresInHours)} hours and can only be used once.\n\nIf you didn't expect this email, ignore it or contact support@crivacy.io.`,
  };
}

export function ticketUpdateEmail(params: {
  displayName: string;
  ticketRef: string;
  ticketSubject: string;
  message: string;
  ticketUrl: string;
}): EmailContent {
  // Every interpolation here is attacker-controlled: ticket subject
  // and message body come from user-submitted ticket content, the
  // ticketRef embeds an auto-generated id but still reaches the HTML.
  // Without escape the support-reply email becomes a stored-XSS
  // delivery vehicle the moment an attacker files a ticket with
  // a `<script>` subject and the agent replies.
  const safeName = escapeHtml(params.displayName);
  const safeRef = escapeHtml(params.ticketRef);
  const safeSubject = escapeHtml(params.ticketSubject);
  const safeMessage = escapeHtml(params.message);
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">New reply on ${safeRef}</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 8px;">There's a new reply on your ticket <strong>${safeRef}: ${safeSubject}</strong></p>
    <div style="margin:16px 0;padding:16px;background-color:${BG_COLOR};border-radius:8px;border:1px solid #1f1f23;">
      <p style="margin:0;font-size:14px;color:${FG_COLOR};white-space:pre-wrap;">${safeMessage}</p>
    </div>
    ${button('View Ticket', params.ticketUrl)}`;

  return {
    subject: `Reply on ${params.ticketRef} — Crivacy`,
    html: layout(`Reply on ${params.ticketRef}`, body),
    text: `Hi ${params.displayName},\n\nNew reply on ${params.ticketRef}: ${params.ticketSubject}\n\n${params.message}\n\nView: ${params.ticketUrl}`,
  };
}

export function emailChangeVerificationEmail(params: {
  displayName: string;
  code: string;
  newEmail: string;
  expiresInMinutes: number;
}): EmailContent {
  const safeName = escapeHtml(params.displayName);
  const safeNewEmail = escapeHtml(params.newEmail);
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">Verify your new email</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 24px;">Enter this code to confirm <strong>${safeNewEmail}</strong> as your new email address:</p>
    <div style="margin:0 0 24px;padding:24px 16px;background-color:#0a0a0b;border-radius:8px;border:1px solid #1f1f23;text-align:center;">
      <span style="display:inline-block;font-size:32px;font-weight:700;letter-spacing:10px;font-family:'Courier New',Courier,monospace;color:${BRAND_COLOR};white-space:nowrap;">${params.code}</span>
    </div>
    <p style="margin:0;font-size:13px;color:${MUTED_COLOR};">
      This code expires in ${params.expiresInMinutes} minutes. If you didn't request this change, you can safely ignore this email.
    </p>`;

  return {
    subject: 'Verify your new email — Crivacy',
    html: layout('Verify your new email', body),
    text: `Hi ${params.displayName},\n\nYour email change verification code is: ${params.code}\n\nThis code expires in ${params.expiresInMinutes} minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
  };
}

export function emailChangedNotificationEmail(params: {
  displayName: string;
  oldEmail: string;
  newEmail: string;
  securityUrl: string;
}): EmailContent {
  const safeName = escapeHtml(params.displayName);
  const safeOld = escapeHtml(params.oldEmail);
  const safeNew = escapeHtml(params.newEmail);
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">Email address changed</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 8px;">The email address on your Crivacy account was changed from <strong>${safeOld}</strong> to <strong>${safeNew}</strong>.</p>
    <p style="margin:0 0 16px;">If you made this change, no action is needed. If you didn't, secure your account immediately.</p>
    ${button('Review Security Settings', params.securityUrl)}`;

  return {
    subject: 'Your email was changed — Crivacy',
    html: layout('Email address changed', body),
    text: `Hi ${params.displayName},\n\nYour Crivacy email was changed from ${params.oldEmail} to ${params.newEmail}.\n\nIf you didn't make this change, secure your account: ${params.securityUrl}`,
  };
}

export function newLoginAlertEmail(params: {
  displayName: string;
  deviceName: string;
  city: string;
  ipAddress: string;
  timestamp: string;
  securityUrl: string;
}): EmailContent {
  // deviceName + city + ipAddress are derived from the incoming
  // request (User-Agent parse, GeoIP lookup, X-Forwarded-For). Any
  // of those can be trivially crafted by the signer — UA strings
  // routinely contain attacker-chosen text — so every row has to
  // be escaped.
  const safeName = escapeHtml(params.displayName);
  const safeDevice = escapeHtml(params.deviceName);
  const safeCity = escapeHtml(params.city);
  const safeIp = escapeHtml(params.ipAddress);
  const safeTime = escapeHtml(params.timestamp);
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">New sign-in detected</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 16px;">A new sign-in to your Crivacy account was detected:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:14px;color:${FG_COLOR};">
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">Device</td><td>${safeDevice}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">Location</td><td>${safeCity}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">IP</td><td>${safeIp}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">Time</td><td>${safeTime}</td></tr>
    </table>
    <p style="margin:0 0 8px;">If this was you, no action is needed. If you don't recognize this sign-in, secure your account immediately.</p>
    ${button('Review Sessions', params.securityUrl)}`;

  return {
    subject: 'New sign-in to your Crivacy account',
    html: layout('New sign-in detected', body),
    text: `Hi ${params.displayName},\n\nNew sign-in detected:\nDevice: ${params.deviceName}\nLocation: ${params.city}\nIP: ${params.ipAddress}\nTime: ${params.timestamp}\n\nIf this wasn't you, secure your account: ${params.securityUrl}`,
  };
}

/* ---------- TOTP family ---------- */

/**
 * Notification sent when the account's TOTP enrolment changes. Three
 * variants share one template — `eventKind` selects the subject +
 * lead copy:
 *
 *   - `enrolled` — first-time TOTP enrolment.
 *   - `replaced` — TOTP secret rotated via the replace endpoint
 *     (existing enrolment swapped for a fresh secret + recovery codes).
 *   - `disabled` — TOTP turned off.
 *
 * Copy never includes the secret, otpauth URL, or any recovery code.
 * Standard "if this wasn't you" rollback hint points the recipient at
 * their security settings to revoke other sessions and contact
 * support. Industry parity: GitHub / Stripe / Google all surface this
 * surface change out-of-band even when it was the user themselves
 * minutes earlier.
 */
export function totpChangedEmail(params: {
  displayName: string;
  audience: 'firm' | 'admin';
  eventKind: 'enrolled' | 'replaced' | 'disabled';
  timestamp: string;
  ipAddress: string;
  securityUrl: string;
}): EmailContent {
  const safeName = escapeHtml(params.displayName);
  const safeTime = escapeHtml(params.timestamp);
  const safeIp = escapeHtml(params.ipAddress);
  const subjectText =
    params.eventKind === 'enrolled'
      ? 'Two-factor authentication enabled on your Crivacy account'
      : params.eventKind === 'replaced'
        ? 'Your Crivacy two-factor authentication was reset'
        : 'Two-factor authentication disabled on your Crivacy account';
  const heading =
    params.eventKind === 'enrolled'
      ? 'Two-factor authentication enabled'
      : params.eventKind === 'replaced'
        ? 'Two-factor authentication reset'
        : 'Two-factor authentication disabled';
  const lead =
    params.eventKind === 'enrolled'
      ? 'Two-factor authentication has been enabled on your Crivacy account. New sign-ins will require an authenticator code in addition to your password.'
      : params.eventKind === 'replaced'
        ? 'The authenticator secret on your Crivacy account was reset. The previous secret no longer works, and a fresh set of recovery codes was generated.'
        : 'Two-factor authentication has been turned off on your Crivacy account. Sign-ins now require only your password.';
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">${heading}</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 16px;">${lead}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:14px;color:${FG_COLOR};">
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">Time</td><td>${safeTime}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">IP</td><td>${safeIp}</td></tr>
    </table>
    <p style="margin:0 0 8px;">If this was you, no action is needed. If you don't recognise this change, secure your account immediately — every other active session has already been signed out.</p>
    ${button('Review Security Settings', params.securityUrl)}
    <p style="margin:16px 0 0;font-size:13px;color:${MUTED_COLOR};">
      If you didn't ask for this and can't sign in, contact
      <a href="mailto:support@crivacy.io" style="color:${BRAND_COLOR};text-decoration:underline;">support@crivacy.io</a>.
    </p>`;
  return {
    subject: subjectText,
    html: layout(heading, body),
    text: `Hi ${params.displayName},\n\n${lead}\n\nTime: ${params.timestamp}\nIP: ${params.ipAddress}\n\nIf this wasn't you, secure your account: ${params.securityUrl}`,
  };
}

/**
 * Notification sent when the account's recovery codes are regenerated
 * via the self-service endpoint. Old codes are invalidated atomically
 * with the new set's INSERT, so the recipient knows that any printed
 * or password-managed copy of the previous codes is now useless.
 *
 * The email never includes the actual recovery codes — those are
 * presented in the dashboard once and not re-shown. Standard "review
 * security settings" affordance lets the user revoke sessions if the
 * regeneration was attacker-driven.
 */
export function recoveryCodesRegeneratedEmail(params: {
  displayName: string;
  audience: 'firm' | 'admin';
  timestamp: string;
  ipAddress: string;
  securityUrl: string;
}): EmailContent {
  const safeName = escapeHtml(params.displayName);
  const safeTime = escapeHtml(params.timestamp);
  const safeIp = escapeHtml(params.ipAddress);
  const subjectText = 'Your Crivacy recovery codes were regenerated';
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">Recovery codes regenerated</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 16px;">A fresh set of recovery codes was generated on your Crivacy account. Any previous codes are now invalid — make sure to download or copy the new set from your security settings.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:14px;color:${FG_COLOR};">
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">Time</td><td>${safeTime}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">IP</td><td>${safeIp}</td></tr>
    </table>
    <p style="margin:0 0 8px;">If this was you, no action is needed. If you don't recognise this change, secure your account immediately — your TOTP enrolment was unchanged but the new codes can be used as a single-factor backup.</p>
    ${button('Review Security Settings', params.securityUrl)}
    <p style="margin:16px 0 0;font-size:13px;color:${MUTED_COLOR};">
      If you didn't ask for this and can't sign in, contact
      <a href="mailto:support@crivacy.io" style="color:${BRAND_COLOR};text-decoration:underline;">support@crivacy.io</a>.
    </p>`;
  return {
    subject: subjectText,
    html: layout('Recovery codes regenerated', body),
    text: `Hi ${params.displayName},\n\nA fresh set of recovery codes was generated on your Crivacy account. Any previous codes are now invalid.\n\nTime: ${params.timestamp}\nIP: ${params.ipAddress}\n\nIf this wasn't you, secure your account: ${params.securityUrl}`,
  };
}

/* ---------- Account locked (failed-login threshold) ---------- */

/**
 * Notification fired when the failed-login counter for the account
 * crosses the lockout threshold and the row flips into the
 * `locked` state for the lockout window. The audit row already
 * exists at the threshold-crossing site (`<aud>.login.failed +
 * meta.reason='*_locked_now'`) — this email is the user-facing leg.
 *
 * Industry parity (GitHub, Stripe, AWS) — surfacing the lock event
 * out-of-band lets the legitimate owner notice a brute-force attempt
 * even when the spray was driven by a stolen email + random
 * passwords. Copy is intentionally generic about which credential
 * leg failed (`reason` only ships internally for forensic triage,
 * never to the recipient).
 */
export function accountLockedEmail(params: {
  displayName: string;
  audience: 'customer' | 'firm' | 'admin';
  ipAddress: string;
  lockedUntil: string;
  securityUrl: string;
}): EmailContent {
  const safeName = escapeHtml(params.displayName);
  const safeIp = escapeHtml(params.ipAddress);
  const safeLockedUntil = escapeHtml(params.lockedUntil);
  const subjectText = 'Your Crivacy account was temporarily locked';
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">Account temporarily locked</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 16px;">Your Crivacy account was just temporarily locked after several failed sign-in attempts. New sign-ins will be refused until the lock window expires.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:14px;color:${FG_COLOR};">
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">Locked until</td><td>${safeLockedUntil}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">IP</td><td>${safeIp}</td></tr>
    </table>
    <p style="margin:0 0 8px;">If this was you, wait for the lock window to expire and try again — or reset your password to regain access immediately. If it wasn't you, your password may be the target of a guessing attack; reset it and review your sessions.</p>
    ${button('Review Security Settings', params.securityUrl)}
    <p style="margin:16px 0 0;font-size:13px;color:${MUTED_COLOR};">
      If you can't sign in even after the lock expires, contact
      <a href="mailto:support@crivacy.io" style="color:${BRAND_COLOR};text-decoration:underline;">support@crivacy.io</a>.
    </p>`;
  return {
    subject: subjectText,
    html: layout('Account temporarily locked', body),
    text: `Hi ${params.displayName},\n\nYour Crivacy account was just temporarily locked after several failed sign-in attempts.\n\nLocked until: ${params.lockedUntil}\nIP: ${params.ipAddress}\n\nIf this wasn't you, reset your password and review sessions: ${params.securityUrl}`,
  };
}

/* ---------- Linked-account changed ---------- */

/**
 * Notification fired when a Google or wallet authentication method is
 * added to or removed from a customer account. The audit row already
 * exists inline at the link/unlink callsite — this email is the
 * user-facing leg of the audit-frontend parity rule (Cat 14 family).
 *
 * `provider × eventKind` discriminates the four sub-cases. Copy stays
 * uniform across providers: the headline names the provider, the body
 * confirms add vs remove and points the recipient at security
 * settings if they didn't expect the change.
 */
export function linkedAccountChangedEmail(params: {
  displayName: string;
  provider: 'google' | 'wallet';
  eventKind: 'added' | 'removed';
  timestamp: string;
  ipAddress: string;
  securityUrl: string;
}): EmailContent {
  const safeName = escapeHtml(params.displayName);
  const safeTime = escapeHtml(params.timestamp);
  const safeIp = escapeHtml(params.ipAddress);
  const providerLabel = params.provider === 'google' ? 'Google' : 'chain wallet';
  const heading =
    params.eventKind === 'added'
      ? `${providerLabel} sign-in linked`
      : `${providerLabel} sign-in removed`;
  const subjectText =
    params.eventKind === 'added'
      ? `${providerLabel} sign-in linked to your Crivacy account`
      : `${providerLabel} sign-in removed from your Crivacy account`;
  const lead =
    params.eventKind === 'added'
      ? `${providerLabel} sign-in was linked to your Crivacy account. You can now use it in addition to your existing sign-in methods.`
      : `${providerLabel} sign-in was removed from your Crivacy account. You can no longer use it to sign in.`;
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">${heading}</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 16px;">${lead}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:14px;color:${FG_COLOR};">
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">Time</td><td>${safeTime}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">IP</td><td>${safeIp}</td></tr>
    </table>
    <p style="margin:0 0 8px;">If this was you, no action is needed. If you don't recognise this change, secure your account immediately and review your sessions.</p>
    ${button('Review Security Settings', params.securityUrl)}
    <p style="margin:16px 0 0;font-size:13px;color:${MUTED_COLOR};">
      If you didn't ask for this and can't sign in, contact
      <a href="mailto:support@crivacy.io" style="color:${BRAND_COLOR};text-decoration:underline;">support@crivacy.io</a>.
    </p>`;
  return {
    subject: subjectText,
    html: layout(heading, body),
    text: `Hi ${params.displayName},\n\n${lead}\n\nTime: ${params.timestamp}\nIP: ${params.ipAddress}\n\nIf this wasn't you, secure your account: ${params.securityUrl}`,
  };
}

/* ---------- Session reuse detected (token-family revoke) ---------- */

/**
 * Notification fired when the refresh-token reuse-detection branch
 * fires (OWASP ASVS V3.5.5). The session was just revoked because a
 * stale refresh token was replayed past the 5s race-grace window —
 * usually a sign that a copy of the session token was captured and
 * used elsewhere. Copy is intentionally non-technical (matches Auth0 /
 * GitHub "suspicious activity" notices) so non-expert users understand
 * the action they need to take: sign in again + secure the account if
 * unrecognised.
 *
 * `securityUrl` is audience-specific (customer → /customer/security,
 * firm → /dashboard/security, admin → /admin/security) — resolved by
 * the subscriber, not this template.
 */
export function sessionReuseDetectedEmail(params: {
  displayName: string;
  timestamp: string;
  ipAddress: string;
  securityUrl: string;
}): EmailContent {
  const safeName = escapeHtml(params.displayName);
  const safeTime = escapeHtml(params.timestamp);
  const safeIp = escapeHtml(params.ipAddress);
  // Subject stays ASCII-only on purpose: any non-ASCII char (em-dash,
  // smart quotes) forces nodemailer to emit a `=?UTF-8?Q?...?=` MIME-
  // encoded header, which breaks downstream substring matching in
  // SMTP-debug inboxes (mailhog) and some plaintext mail clients.
  const subjectText = 'Suspicious activity on your Crivacy account - sign in again';
  const heading = 'Suspicious activity detected';
  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">${heading}</h2>
    <p style="margin:0 0 8px;">Hi ${safeName},</p>
    <p style="margin:0 0 16px;">We detected unusual activity on your Crivacy account and signed you out as a precaution. This can happen if your session was accessed from another device or network. Please sign in again.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:14px;color:${FG_COLOR};">
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">Time</td><td>${safeTime}</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:${MUTED_COLOR};">IP</td><td>${safeIp}</td></tr>
    </table>
    <p style="margin:0 0 8px;">If you don't recognize this activity, change your password immediately and review your account security settings.</p>
    ${button('Review Security Settings', params.securityUrl)}
    <p style="margin:16px 0 0;font-size:13px;color:${MUTED_COLOR};">
      If you can't sign in or need help securing your account, contact
      <a href="mailto:support@crivacy.io" style="color:${BRAND_COLOR};text-decoration:underline;">support@crivacy.io</a>.
    </p>`;
  return {
    subject: subjectText,
    html: layout(heading, body),
    text: `Hi ${params.displayName},\n\nWe detected unusual activity on your Crivacy account and signed you out as a precaution. This can happen if your session was accessed from another device or network. Please sign in again.\n\nTime: ${params.timestamp}\nIP: ${params.ipAddress}\n\nIf you don't recognize this activity, change your password immediately and review your account security settings: ${params.securityUrl}`,
  };
}

/* ---------- Account status change ---------- */

/**
 * All admin actions that trigger a status change notification email.
 *
 * - `banned` / `suspended` / `locked` — restrictive actions (user can't log in)
 * - `unbanned` — ban lifted, account active, user can log in
 * - `unbanned_review` — ban lifted but account moved to suspended (needs admin activate)
 * - `unlocked` / `activated` — user can log in again
 * - `kyc_reset` — KYC verification reset, user must re-verify
 */
export type AccountStatusAction =
  | 'banned'
  | 'suspended'
  | 'locked'
  | 'unbanned'
  | 'unbanned_review'
  | 'unlocked'
  | 'activated'
  | 'kyc_reset';

interface StatusEmailSpec {
  readonly subject: string;
  readonly heading: string;
  readonly message: string;
  /** CTA button label. Omit for actions where the user can't log in. */
  readonly ctaText?: string;
  /** CTA relative path appended to NEXT_PUBLIC_APP_URL. */
  readonly ctaPath?: string;
  /** Whether to show a "contact support" note (for restrictive actions). */
  readonly supportNote: boolean;
}

const STATUS_EMAIL_SPECS: Readonly<Record<AccountStatusAction, StatusEmailSpec>> = {
  banned: {
    subject: 'Important update about your Crivacy account',
    heading: 'Account access restricted',
    message: 'Your Crivacy account has been restricted due to a policy violation. All active sessions and credentials have been revoked.',
    supportNote: true,
  },
  suspended: {
    subject: 'Your Crivacy account has been suspended',
    heading: 'Account suspended',
    message: 'Your Crivacy account has been temporarily suspended. You will not be able to sign in until the suspension is lifted.',
    supportNote: true,
  },
  locked: {
    subject: 'Your Crivacy account has been locked',
    heading: 'Account locked',
    message: 'Your Crivacy account has been locked for security reasons. You will not be able to sign in until the lock is removed.',
    supportNote: true,
  },
  unbanned: {
    subject: 'Your Crivacy account has been reinstated',
    heading: 'Account reinstated',
    message: 'The restriction on your Crivacy account has been removed. You can now sign in and use your account.',
    ctaText: 'Sign In',
    ctaPath: '/login',
    supportNote: false,
  },
  unbanned_review: {
    subject: 'Your Crivacy account ban has been lifted',
    heading: 'Account ban lifted',
    message: 'The ban on your Crivacy account has been lifted. Your account is now under review and an administrator will finalize your account status.',
    supportNote: true,
  },
  unlocked: {
    subject: 'Your Crivacy account has been unlocked',
    heading: 'Account unlocked',
    message: 'Your Crivacy account has been unlocked. You can now sign in again.',
    ctaText: 'Sign In',
    ctaPath: '/login',
    supportNote: false,
  },
  activated: {
    subject: 'Your Crivacy account has been reactivated',
    heading: 'Account reactivated',
    message: 'Your Crivacy account has been reactivated. You can now sign in and use all features.',
    ctaText: 'Sign In',
    ctaPath: '/login',
    supportNote: false,
  },
  kyc_reset: {
    subject: 'Your identity verification has been reset — Crivacy',
    heading: 'Verification reset',
    message: 'Your identity verification (KYC) has been reset. Please complete the verification process again to restore your credential level.',
    ctaText: 'Start Verification',
    ctaPath: '/kyc',
    supportNote: false,
  },
};

/**
 * KYC verification lifecycle actions that warrant a customer email
 * (in addition to the in-app bell notification fired alongside).
 *
 *  - `resubmission_required` — Didit asked the user to redo specific
 *    flagged steps. Email points back to the verification flow with
 *    the optional list of features to repeat.
 *  - `kyc_expired` — A previously-approved verification crossed the
 *    expiration policy and the on-chain credential was revoked. Email
 *    nudges the user to re-verify so they can continue using verified
 *    services.
 *
 * `in_review` intentionally has no email entry — the customer's only
 * action is "wait", so a passive in-app banner + bell badge is enough
 * (avoids overcommunicating an outcome the user can't influence).
 */
export type KycStatusAction = 'resubmission_required' | 'kyc_expired';

interface KycStatusEmailSpec {
  readonly subject: string;
  readonly heading: string;
  readonly message: string;
  readonly ctaText: string;
  readonly ctaPath: string;
}

const KYC_STATUS_EMAIL_SPECS: Readonly<Record<KycStatusAction, KycStatusEmailSpec>> = {
  resubmission_required: {
    subject: 'Verification: a few steps need redoing — Crivacy',
    heading: 'Resubmission required',
    message:
      'Compliance reviewed your verification and asked you to redo a few specific steps. Your earlier submissions are saved — only the flagged steps repeat.',
    ctaText: 'Resume verification',
    ctaPath: '/kyc',
  },
  kyc_expired: {
    subject: 'Your Crivacy KYC credential has expired',
    heading: 'Verification expired',
    message:
      'Your verified identity reached its expiration date and the on-chain credential was revoked. To continue using verified services, complete a new verification.',
    ctaText: 'Re-verify',
    ctaPath: '/kyc',
  },
};

export interface KycStatusChangeEmailInput {
  readonly displayName: string;
  readonly action: KycStatusAction;
  /**
   * Optional human-friendly list of feature labels to redo
   * (`['document photo', 'liveness check']`). Renders as a bullet
   * list in the resubmission email; ignored for `kyc_expired`.
   */
  readonly featureLabels?: readonly string[] | undefined;
  /**
   * Optional Didit hosted-flow URL the user can return to. When present,
   * the email's primary CTA links here directly so the user lands on
   * the flagged steps without going through `/kyc` first.
   */
  readonly resumeUrl?: string | undefined;
}

/**
 * KYC lifecycle email template (resubmission, expiration). Mirrors the
 * `accountStatusChangeEmail` shape so the dispatcher integration stays
 * uniform — the differentiator is the per-action spec table.
 */
export function kycStatusChangeEmail(params: KycStatusChangeEmailInput): EmailContent {
  const spec = KYC_STATUS_EMAIL_SPECS[params.action];
  const appUrl = getAppUrl();

  // Prefer the Didit-hosted resume URL when provided (lands on the
  // flagged steps directly); fall back to the in-app /kyc page.
  const ctaHref =
    params.resumeUrl !== undefined && /^https?:\/\//.test(params.resumeUrl)
      ? params.resumeUrl
      : `${appUrl}${spec.ctaPath}`;

  const featureListHtml =
    params.action === 'resubmission_required' &&
    params.featureLabels !== undefined &&
    params.featureLabels.length > 0
      ? `<div style="margin:16px 0;padding:12px 16px;background-color:${BG_COLOR};border-radius:8px;border:1px solid #1f1f23;">
          <p style="margin:0 0 8px;font-size:13px;color:${MUTED_COLOR};"><strong style="color:${FG_COLOR};">Steps to redo:</strong></p>
          <ul style="margin:0;padding-left:18px;font-size:14px;color:${FG_COLOR};line-height:1.7;">
            ${params.featureLabels.map((label) => `<li>${escapeHtml(label)}</li>`).join('\n            ')}
          </ul>
        </div>`
      : '';

  const ctaHtml = button(spec.ctaText, ctaHref);

  const supportHtml = `<p style="margin:16px 0 0;font-size:13px;color:${MUTED_COLOR};">
        If you have questions, please contact
        <a href="mailto:support@crivacy.io" style="color:${BRAND_COLOR};text-decoration:underline;">support@crivacy.io</a>.
      </p>`;

  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">${spec.heading}</h2>
    <p style="margin:0 0 8px;">Hi ${escapeHtml(params.displayName)},</p>
    <p style="margin:0 0 8px;">${spec.message}</p>
    ${featureListHtml}
    ${ctaHtml}
    ${supportHtml}`;

  let text = `Hi ${params.displayName},\n\n${spec.message}`;
  if (
    params.action === 'resubmission_required' &&
    params.featureLabels !== undefined &&
    params.featureLabels.length > 0
  ) {
    text += `\n\nSteps to redo:\n${params.featureLabels.map((l) => `  - ${l}`).join('\n')}`;
  }
  text += `\n\n${spec.ctaText}: ${ctaHref}`;
  text += '\n\nIf you have questions, contact support@crivacy.io.';

  return {
    subject: spec.subject,
    html: layout(spec.heading, body),
    text,
  };
}

/**
 * Email template for admin-initiated account status changes.
 *
 * Generates action-specific subject, heading, body, and optional CTA.
 * Restrictive actions (ban, suspend, lock) include a support contact note
 * instead of a sign-in button. CTA URLs require `NEXT_PUBLIC_APP_URL` to
 * be set; if missing, the CTA button is omitted gracefully.
 */
export function accountStatusChangeEmail(params: {
  readonly displayName: string;
  readonly action: AccountStatusAction;
  readonly reason?: string | undefined;
}): EmailContent {
  const spec = STATUS_EMAIL_SPECS[params.action];
  const appUrl = getAppUrl();

  const reasonHtml = params.reason !== undefined && params.reason.length > 0
    ? `<div style="margin:16px 0;padding:12px 16px;background-color:${BG_COLOR};border-radius:8px;border:1px solid #1f1f23;">
        <p style="margin:0;font-size:13px;color:${MUTED_COLOR};"><strong style="color:${FG_COLOR};">Reason:</strong> ${escapeHtml(params.reason)}</p>
      </div>`
    : '';

  const ctaHtml = spec.ctaText !== undefined && spec.ctaPath !== undefined
    ? button(spec.ctaText, `${appUrl}${spec.ctaPath}`)
    : '';

  const supportHtml = spec.supportNote
    ? `<p style="margin:16px 0 0;font-size:13px;color:${MUTED_COLOR};">
        If you have questions about this action, please contact
        <a href="mailto:support@crivacy.io" style="color:${BRAND_COLOR};text-decoration:underline;">support@crivacy.io</a>.
      </p>`
    : '';

  const body = `
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:${FG_COLOR};">${spec.heading}</h2>
    <p style="margin:0 0 8px;">Hi ${escapeHtml(params.displayName)},</p>
    <p style="margin:0 0 8px;">${spec.message}</p>
    ${reasonHtml}
    ${ctaHtml}
    ${supportHtml}`;

  let text = `Hi ${params.displayName},\n\n${spec.message}`;
  if (params.reason !== undefined && params.reason.length > 0) {
    text += `\n\nReason: ${params.reason}`;
  }
  if (spec.ctaText !== undefined && spec.ctaPath !== undefined && appUrl !== undefined) {
    text += `\n\n${spec.ctaText}: ${appUrl}${spec.ctaPath}`;
  }
  if (spec.supportNote) {
    text += '\n\nIf you have questions, contact support@crivacy.io.';
  }

  return {
    subject: spec.subject,
    html: layout(spec.heading, body),
    text,
  };
}
