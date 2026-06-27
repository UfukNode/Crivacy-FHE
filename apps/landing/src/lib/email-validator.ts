import { promises as dns } from "node:dns";
import disposableDomains from "disposable-email-domains";

// Standard RFC 5322-ish regex. Not exhaustive (the real spec is horrible)
// but catches the 99% of malformed input we care about: missing @, missing
// TLD, trailing spaces, control chars, etc.
const EMAIL_RE =
  /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;

// Pre-computed Set so domain lookups are O(1). The package ships ~3500
// domains so we pay the allocation once per process, not per request.
const disposableSet = new Set<string>(disposableDomains as string[]);

export type EmailValidationResult =
  | { ok: true; email: string; domain: string }
  | { ok: false; reason: "format" | "disposable" | "no-mx" };

export async function validateEmail(
  raw: string,
): Promise<EmailValidationResult> {
  const email = raw.trim().toLowerCase();

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { ok: false, reason: "format" };
  }

  const domain = email.split("@")[1];

  if (disposableSet.has(domain)) {
    return { ok: false, reason: "disposable" };
  }

  // MX lookup — verifies the domain actually accepts mail. Falls back to
  // an A/AAAA lookup because RFC 5321 §5.1 says mailers should use A
  // records if no MX exists. Any DNS error (NXDOMAIN, timeout, etc.)
  // → treat as no-mx so we don't accept unreachable addresses.
  try {
    const mx = await dns.resolveMx(domain);
    if (mx && mx.length > 0) return { ok: true, email, domain };
  } catch {
    // fall through to A lookup
  }

  try {
    const a = await dns.resolve4(domain);
    if (a && a.length > 0) return { ok: true, email, domain };
  } catch {
    // fall through
  }

  return { ok: false, reason: "no-mx" };
}
