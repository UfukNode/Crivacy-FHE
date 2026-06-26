/**
 * Test-FHE-Dapp sign in. PRG: form posts to the sibling route
 * handler, errors come back via `?error=<code>`.
 */

import Link from 'next/link';

export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_credentials: 'Email or password is incorrect.',
  bad_payload: 'Please fill in both fields.',
  unknown: 'Something went wrong. Try again.',
};

export default async function TestFirmLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const errorCode = params.error ?? null;
  const errorMessage = errorCode !== null ? (ERROR_MESSAGES[errorCode] ?? ERROR_MESSAGES['unknown']) : null;

  // Pre-fill the form with the seeded default user when those env
  // vars are set. The seed runs on first auth touch (`user-store.ts`)
  // so signing in with the prefilled values just works on a clean
  // machine. Demo / video friendly. Empty when the env is unset.
  const defaultEmail = process.env['TEST_FIRM_DEFAULT_USER_EMAIL']?.trim() ?? '';
  const defaultPassword = process.env['TEST_FIRM_DEFAULT_USER_PASSWORD'] ?? '';

  return (
    <div className="mx-auto max-w-md space-y-7">
      <header className="space-y-3">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
          Northwind Finance
        </p>
        <h1 className="font-serif text-[28px] font-normal tracking-tight text-stone-50">
          Sign in
        </h1>
        <p className="text-[13.5px] leading-[1.7] text-stone-400">
          Access your account to verify your identity and manage your profile.
        </p>
      </header>

      {errorMessage !== null ? (
        <div className="rounded-lg border border-stone-800 bg-stone-900/40 p-3 text-sm text-stone-200">
          {errorMessage}
        </div>
      ) : null}

      <form
        method="POST"
        action="/api/login"
        className="space-y-5 rounded-2xl border border-stone-800 bg-stone-900/30 p-7"
      >
        <div className="space-y-2">
          <label htmlFor="email" className="block font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
            email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            defaultValue={defaultEmail}
            className="block w-full rounded-md border border-stone-700 bg-stone-950/40 px-3 py-2.5 text-sm text-stone-100 placeholder:text-stone-600 focus:border-[#cc785c] focus:outline-none focus:ring-1 focus:ring-[#cc785c]/40"
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="password" className="block font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
            password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            defaultValue={defaultPassword}
            className="block w-full rounded-md border border-stone-700 bg-stone-950/40 px-3 py-2.5 text-sm text-stone-100 placeholder:text-stone-600 focus:border-[#cc785c] focus:outline-none focus:ring-1 focus:ring-[#cc785c]/40"
          />
        </div>
        <button
          type="submit"
          className="w-full rounded-md bg-[#cc785c] px-4 py-2.5 text-sm font-medium text-stone-50 transition-colors hover:bg-[#d4886e]"
        >
          Continue
        </button>
      </form>

      <p className="text-center text-[13px] text-stone-500">
        New here?{' '}
        <Link href="/register" className="font-medium text-[#e8a684] hover:text-[#f0bb9c]">
          Create an account
        </Link>
      </p>
    </div>
  );
}
