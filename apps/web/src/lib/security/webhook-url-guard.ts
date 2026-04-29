/**
 * Webhook URL safety guard — SSRF prevention.
 *
 * A webhook endpoint URL is user-controlled: a firm admin types it
 * into a form, and the delivery worker fetches it on their behalf.
 * Without a guard, a malicious or curious operator can point the
 * URL at:
 *
 *   * `http://localhost:5432/` — scan / hit internal services
 *   * `https://169.254.169.254/` — AWS/GCP/Azure cloud metadata
 *     endpoint; credential theft vector
 *   * `https://10.0.0.x/` or `https://192.168.x.x/` — VPC lateral
 *     movement
 *   * Link-local / CGNAT / unspecified ranges — same class
 *
 * This module rejects those inputs. It runs in **two** places:
 *
 *   1. At the create/update boundary (synchronous Zod refine won't
 *      work because DNS resolution is async, so handlers call it
 *      explicitly after parse).
 *   2. At delivery time too would be belt-and-suspenders, but that
 *      worker lives in a separate commit; for now the create gate
 *      is the one that closes the door.
 *
 * Implementation notes:
 *
 *   * We resolve the hostname to **all** A / AAAA records and reject
 *     if **any** resolve to a blocked range — this is the only way
 *     to defeat DNS rebinding at the validation step.
 *   * IP-literal hostnames (e.g. `https://127.0.0.1/`) are caught
 *     before DNS; we detect them by parsing with `net.isIP`.
 *   * A handful of names (`localhost`, `metadata.google.internal`,
 *     `metadata.azure.com`) are rejected by name even when they
 *     resolve to a public IP, because any resolution path that
 *     touches them is suspicious.
 *   * The check is opt-in bypassed when
 *     `CRIVACY_WEBHOOK_URL_GUARD_ALLOW_PRIVATE=true` — intended for
 *     local-dev test harnesses only. The env var is read every call
 *     (not cached) so tests can toggle it per-case.
 *
 * @module
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export type WebhookUrlCheck =
  | { readonly ok: true; readonly normalised: string }
  | { readonly ok: false; readonly reason: string };

// Hostnames that must never be dialled from the delivery worker,
// even if DNS resolves them to a public IP. Lowercase, exact match.
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'metadata.google.internal',
  'metadata',
  'metadata.goog',
  'metadata.azure.com',
  'instance-data',
]);

function isPrivateIPv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0] = octets;
  // RFC 1918 — 10/8, 172.16/12, 192.168/16
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Loopback — 127/8
  if (a === 127) return true;
  // Link-local + cloud metadata — 169.254/16
  if (a === 169 && b === 254) return true;
  // Unspecified — 0/8
  if (a === 0) return true;
  // CGNAT — 100.64/10
  if (a === 100 && b >= 64 && b <= 127) return true;
  // Multicast — 224/4
  if (a >= 224 && a <= 239) return true;
  // Reserved — 240/4 (includes 255.255.255.255 broadcast)
  if (a >= 240) return true;
  return false;
}

function parseIPv4Octets(addr: string): readonly number[] | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  // Unspecified (::) + loopback (::1)
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4
  const v4MappedMatch = lower.match(/^::ffff:([0-9.]+)$/);
  if (v4MappedMatch !== null && v4MappedMatch[1] !== undefined) {
    const octets = parseIPv4Octets(v4MappedMatch[1]);
    if (octets !== null && isPrivateIPv4(octets)) return true;
  }
  // Link-local — fe80::/10
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true;
  }
  // Unique local addresses — fc00::/7 (fc.. / fd..)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // Multicast — ff00::/8
  if (lower.startsWith('ff')) return true;
  return false;
}

/**
 * `true` when the given IP literal belongs to a range a webhook
 * delivery worker must never reach.
 */
function isBlockedIp(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) {
    const octets = parseIPv4Octets(addr);
    return octets === null ? true : isPrivateIPv4(octets);
  }
  if (kind === 6) {
    return isPrivateIPv6(addr);
  }
  // Unknown IP shape — default-deny.
  return true;
}

/**
 * Validate a webhook URL for SSRF-safety. Resolves DNS; async.
 *
 *   * Scheme must be `https:`.
 *   * Host must not be a blocked name (`localhost` etc.).
 *   * If the host is an IP literal, it must be a public IP.
 *   * Otherwise, every resolved A/AAAA must be a public IP.
 *
 * Returns a discriminated union so callers can forward `reason` to
 * the user verbatim without a try/catch-based flow.
 */
export async function ensureWebhookUrlSafe(rawUrl: string): Promise<WebhookUrlCheck> {
  if (process.env['CRIVACY_WEBHOOK_URL_GUARD_ALLOW_PRIVATE'] === 'true') {
    return { ok: true, normalised: rawUrl };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'URL is not a valid absolute URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'URL must use the `https://` scheme.' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'URL must not contain credentials.' };
  }

  const host = parsed.hostname.toLowerCase();
  if (host === '') {
    return { ok: false, reason: 'URL must contain a host.' };
  }
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: `Host \`${host}\` is not allowed.` };
  }
  // IPv6 hosts arrive as `[::1]` in URL parsing; the square brackets
  // are stripped by `hostname`. We normalise by checking `isIP`.
  const hostKind = isIP(host);
  if (hostKind !== 0) {
    if (isBlockedIp(host)) {
      return {
        ok: false,
        reason: 'URL resolves to a private, loopback, or link-local address.',
      };
    }
    return { ok: true, normalised: parsed.toString() };
  }

  // DNS resolution — grab ALL addresses so we can reject DNS
  // rebinding games where one resolution returns public and the
  // next returns private.
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return {
      ok: false,
      reason: `Could not resolve host \`${host}\`. Check the URL and DNS records.`,
    };
  }
  if (addresses.length === 0) {
    return {
      ok: false,
      reason: `Host \`${host}\` did not resolve to any address.`,
    };
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      return {
        ok: false,
        reason: 'URL resolves to a private, loopback, or link-local address.',
      };
    }
  }

  return { ok: true, normalised: parsed.toString() };
}
