/**
 * Cloudflare Turnstile server-side token verification.
 *
 * @module
 */

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileVerifyResult {
  readonly success: boolean;
  readonly errorCodes: readonly string[];
}

/**
 * Verify a Turnstile token server-side.
 *
 * @param token - The token from the client widget
 * @param secretKey - TURNSTILE_SECRET_KEY
 * @param ip - Client IP for additional validation (optional)
 * @returns verification result
 */
export async function verifyTurnstileToken(
  token: string,
  secretKey: string,
  ip?: string | null,
): Promise<TurnstileVerifyResult> {
  // Fail-loud on empty secret: this is a config bug in the caller
  // (should be routed through the central config which rejects empty
  // env at startup). Dev bypass is deliberately removed — a missing
  // TURNSTILE_SECRET_KEY in any environment means bot protection is
  // off, which is unacceptable for credential-accepting surfaces.
  if (!secretKey || secretKey.length === 0) {
    throw new Error(
      '[turnstile] verifyTurnstileToken called with empty secretKey. ' +
        'Caller must pass a non-empty secret (central config: getCustomerAuthConfig().turnstileSecretKey).',
    );
  }

  if (!token || token.length === 0) {
    return { success: false, errorCodes: ['missing-input-response'] };
  }

  const formData = new URLSearchParams();
  formData.append('secret', secretKey);
  formData.append('response', token);
  if (ip) {
    formData.append('remoteip', ip);
  }

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: formData,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (!response.ok) {
      return { success: false, errorCodes: ['turnstile-service-error'] };
    }

    const data = (await response.json()) as {
      success: boolean;
      'error-codes'?: string[];
    };

    return {
      success: data.success,
      errorCodes: data['error-codes'] ?? [],
    };
  } catch {
    return { success: false, errorCodes: ['turnstile-network-error'] };
  }
}
