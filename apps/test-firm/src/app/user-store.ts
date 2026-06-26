/**
 * TestFirm user + session store.
 *
 * TestFirm is a dev harness standing in for a real B2B consumer of
 * Crivacy. The directory lives in process memory plus a JSON file
 * mirror:
 *
 *   - users: keyed by email + id, in-process Map
 *   - sessions: in-process Map (lost on restart, that's fine — the
 *     user re-signs in)
 *   - persistence: `.test-firm-users.json` next to the app root.
 *     Keeps users across Next.js hot-reloads so you don't lose your
 *     credentials every time you edit a file. Gitignored via the
 *     `.test-firm-*` prefix in the project root `.gitignore`.
 *
 * Passwords are hashed via the existing argon2id helper. A random
 * password is hashed at first login miss to keep the "user not
 * found" branch indistinguishable from "bad password" in wall-time
 * (classic email-enumeration defence, but done with a real argon2
 * hash this time rather than a synthetic string that argon2 refuses
 * to parse — that earlier shortcut threw inside verifyPassword and
 * promoted the "user unknown" case to a 500).
 */

import 'server-only';

import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { getAuthConfig } from '@/lib/auth/config';
import { AuthError } from '@/lib/auth/errors';
import { hashPassword, verifyPassword } from '@/lib/auth/password';

export interface TestFirmUser {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly createdAt: Date;
  /**
   * Human display name captured at registration. A real firm collects
   * a first/last name during sign-up; this harness mirrors that so the
   * dashboard's pre-link profile card has something honest to render
   * instead of guessing initials off the email local-part (which read
   * as "Demo" for an email like `demo@…`).
   *
   * Optional on the type for back-compat: older persisted snapshots
   * predate the field; the loader defaults absent rows to `null` and
   * the UI falls back to the email-derived display in that case.
   */
  readonly displayName: string | null;
}

interface PersistedShape {
  readonly version: 2;
  readonly users: readonly {
    readonly id: string;
    readonly email: string;
    readonly passwordHash: string;
    readonly createdAt: string;
    readonly displayName?: string | null;
  }[];
  readonly sessions: readonly {
    readonly token: string;
    readonly userId: string;
    readonly createdAt: string;
  }[];
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PERSIST_PATH = join(process.cwd(), '.test-firm-users.json');
// HMR touch — drops in-memory `loaded` flag so on-disk snapshot is
// re-read after a manual JSON edit. Bump the comment to force HMR.

const usersByEmail = new Map<string, TestFirmUser>();
const usersById = new Map<string, TestFirmUser>();
const sessions = new Map<string, { userId: string; createdAt: Date }>();

let loaded = false;
let dummyHash: string | null = null;
let seedPromise: Promise<void> | null = null;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Pre-seed a default test user from env vars on first auth touch.
 *
 * The harness exists so a developer / FA recording a video doesn't have
 * to re-register every time the persist file is wiped (clean machine,
 * `git clean`, deliberate reset). When both env vars are present and
 * the email is not already in the store, we hash the password the same
 * way `registerUser` does and write the user out.
 *
 * Both env vars must be set — partial config is treated as "not
 * configured" so a leftover stub doesn't half-create something. The
 * seed is run at most once per process via `seedPromise`.
 */
async function seedDefaultUserIfNeeded(): Promise<void> {
  if (seedPromise !== null) return seedPromise;
  seedPromise = (async () => {
    loadFromDisk();
    const email = process.env['TEST_FIRM_DEFAULT_USER_EMAIL']?.trim();
    const password = process.env['TEST_FIRM_DEFAULT_USER_PASSWORD'];
    if (
      typeof email !== 'string' ||
      email.length === 0 ||
      typeof password !== 'string' ||
      password.length === 0
    ) {
      return;
    }
    const normalized = normalizeEmail(email);
    if (usersByEmail.has(normalized)) return;
    const cfg = { ...getAuthConfig(), passwordMinLength: 1 };
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(password, cfg);
    } catch {
      // Default user seed failures must not break the harness — a real
      // dev can still register manually.
      return;
    }
    const user: TestFirmUser = {
      id: randomUUID(),
      email: normalized,
      passwordHash,
      createdAt: new Date(),
      // Seeded users have no display name input (env-driven); the
      // dashboard falls back to the email-derived rendering.
      displayName: 'Alex Morgan',
    };
    usersByEmail.set(normalized, user);
    usersById.set(user.id, user);
    persistToDisk();
    // eslint-disable-next-line no-console
    console.log(`[test-firm] seeded default user ${normalized}`);
  })();
  return seedPromise;
}

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(PERSIST_PATH, 'utf8');
    const parsed = JSON.parse(raw) as PersistedShape;
    // Accept v1 (users only) and v2 (users + sessions) — the harness
    // survived at least one schema bump cleanly.
    if (!Array.isArray(parsed.users)) return;
    for (const row of parsed.users) {
      const user: TestFirmUser = {
        id: row.id,
        email: row.email,
        passwordHash: row.passwordHash,
        createdAt: new Date(row.createdAt),
        displayName:
          typeof row.displayName === 'string' && row.displayName.length > 0
            ? row.displayName
            : null,
      };
      usersByEmail.set(user.email, user);
      usersById.set(user.id, user);
    }
    if (Array.isArray(parsed.sessions)) {
      for (const row of parsed.sessions) {
        sessions.set(row.token, {
          userId: row.userId,
          createdAt: new Date(row.createdAt),
        });
      }
    }
  } catch (err) {
    // First run (no file) or garbage — ignore.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.warn('[test-firm] failed to load persisted users:', (err as Error).message);
    }
  }
}

function persistToDisk(): void {
  const payload: PersistedShape = {
    version: 2,
    users: Array.from(usersByEmail.values()).map((u) => ({
      id: u.id,
      email: u.email,
      passwordHash: u.passwordHash,
      createdAt: u.createdAt.toISOString(),
      displayName: u.displayName,
    })),
    sessions: Array.from(sessions.entries()).map(([token, session]) => ({
      token,
      userId: session.userId,
      createdAt: session.createdAt.toISOString(),
    })),
  };
  try {
    writeFileSync(PERSIST_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[test-firm] failed to persist users:', (err as Error).message);
  }
}

async function getDummyHash(): Promise<string> {
  if (dummyHash !== null) return dummyHash;
  // Real argon2id hash of a random value. Computed once, reused on
  // every enumeration-guard branch to keep timing stable.
  const cfg = getAuthConfig();
  dummyHash = await hashPassword(randomBytes(32).toString('base64url'), cfg);
  return dummyHash;
}

export type RegisterOutcome =
  | { readonly status: 'created'; readonly user: TestFirmUser }
  | { readonly status: 'email_taken' }
  | { readonly status: 'weak_password'; readonly message: string }
  | { readonly status: 'invalid_email' };

export async function registerUser(
  email: string,
  password: string,
  displayName: string | null,
): Promise<RegisterOutcome> {
  loadFromDisk();
  await seedDefaultUserIfNeeded();

  const trimmed = email.trim();
  if (trimmed.length < 3 || !trimmed.includes('@') || trimmed.length > 320) {
    return { status: 'invalid_email' };
  }
  const normalized = normalizeEmail(trimmed);
  if (usersByEmail.has(normalized)) {
    return { status: 'email_taken' };
  }

  // Relax the min-length rule for this dev harness — real Crivacy
  // customers still live behind the full policy. `hashPassword`'s
  // `weak_password` branch only triggers when the plaintext falls
  // under `passwordMinLength`, so overriding the single field is
  // enough to let short test passwords through without forking the
  // argon config.
  const cfg = { ...getAuthConfig(), passwordMinLength: 1 };
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password, cfg);
  } catch (err) {
    if (err instanceof AuthError && err.code === 'weak_password') {
      return { status: 'weak_password', message: err.message };
    }
    throw err;
  }

  // Normalise display name: trim, clamp at 80 chars, collapse to
  // null when blank so the dashboard's fallback path can fire.
  const trimmedDisplayName =
    typeof displayName === 'string' ? displayName.trim().slice(0, 80) : '';
  const user: TestFirmUser = {
    id: randomUUID(),
    email: normalized,
    passwordHash,
    createdAt: new Date(),
    displayName: trimmedDisplayName.length > 0 ? trimmedDisplayName : null,
  };
  usersByEmail.set(normalized, user);
  usersById.set(user.id, user);
  persistToDisk();
  return { status: 'created', user };
}

export type LoginOutcome =
  | { readonly status: 'ok'; readonly token: string; readonly user: TestFirmUser }
  | { readonly status: 'invalid_credentials' };

export async function loginUser(email: string, password: string): Promise<LoginOutcome> {
  loadFromDisk();
  await seedDefaultUserIfNeeded();

  const normalized = normalizeEmail(email);
  const user = usersByEmail.get(normalized);
  if (user === undefined) {
    // Real argon2 hash keeps wall-time close to the "wrong password"
    // branch, closing the email-enumeration oracle.
    await verifyPassword(password, await getDummyHash());
    return { status: 'invalid_credentials' };
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return { status: 'invalid_credentials' };
  }

  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { userId: user.id, createdAt: new Date() });
  persistToDisk();
  return { status: 'ok', token, user };
}

/** Resolve a session token to the backing user; null if expired/unknown. */
export function findUserBySession(token: string | null | undefined): TestFirmUser | null {
  loadFromDisk();
  if (typeof token !== 'string' || token.length === 0) return null;
  const session = sessions.get(token);
  if (session === undefined) return null;
  if (Date.now() - session.createdAt.getTime() > SESSION_TTL_MS) {
    sessions.delete(token);
    persistToDisk();
    return null;
  }
  return usersById.get(session.userId) ?? null;
}

export function destroySession(token: string | null | undefined): void {
  if (typeof token !== 'string' || token.length === 0) return;
  if (sessions.delete(token)) {
    persistToDisk();
  }
}
