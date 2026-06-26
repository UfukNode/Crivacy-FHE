/**
 * Test-FHE-Dapp register. Sibling route handles the POST. Errors
 * come back via `?error=<code>`.
 */

import Link from 'next/link';

export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_email: 'Email looks invalid.',
  email_taken: 'An account with that email already exists.',
  weak_password: 'Password failed the underlying hash policy.',
  bad_payload: 'Please fill in both fields.',
  unknown: 'Something went wrong. Try again.',
};

export default async function TestFirmRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const errorCode = params.error ?? null;
  const errorMessage = errorCode !== null ? (ERROR_MESSAGES[errorCode] ?? ERROR_MESSAGES['unknown']) : null;

  return (
    <div className="mx-auto max-w-md space-y-7">
      <header className="space-y-3">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
          Northwind Finance
        </p>
        <h1 className="font-serif text-[28px] font-normal tracking-tight text-stone-50">
          Create your account
        </h1>
        <p className="text-[13.5px] leading-[1.7] text-stone-400">
          Set up your Northwind account, then verify your identity with Crivacy in seconds.
        </p>
      </header>

      {errorMessage !== null ? (
        <div className="rounded-lg border border-stone-800 bg-stone-900/40 p-3 text-sm text-stone-200">
          {errorMessage}
        </div>
      ) : null}

      <form
        method="POST"
        action="/api/register"
        className="space-y-5 rounded-2xl border border-stone-800 bg-stone-900/30 p-7"
      >
        <div className="space-y-2">
          <label htmlFor="displayName" className="block font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
            full name
          </label>
          <input
            id="displayName"
            name="displayName"
            type="text"
            required
            maxLength={80}
            autoComplete="name"
            placeholder="Jane Doe"
            className="block w-full rounded-md border border-stone-700 bg-stone-950/40 px-3 py-2.5 text-sm text-stone-100 placeholder:text-stone-600 focus:border-[#cc785c] focus:outline-none focus:ring-1 focus:ring-[#cc785c]/40"
          />
          <p className="text-[11.5px] text-stone-500">
            This is how you&apos;ll appear on your profile.
          </p>
        </div>
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
            minLength={1}
            required
            autoComplete="new-password"
            className="block w-full rounded-md border border-stone-700 bg-stone-950/40 px-3 py-2.5 text-sm text-stone-100 placeholder:text-stone-600 focus:border-[#cc785c] focus:outline-none focus:ring-1 focus:ring-[#cc785c]/40"
          />
          <p className="text-[11.5px] text-stone-500">Choose a password you&apos;ll remember.</p>
        </div>
        <button
          type="submit"
          className="w-full rounded-md bg-[#cc785c] px-4 py-2.5 text-sm font-medium text-stone-50 transition-colors hover:bg-[#d4886e]"
        >
          Create account
        </button>
      </form>

      <p className="text-center text-[13px] text-stone-500">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-[#e8a684] hover:text-[#f0bb9c]">
          Sign in
        </Link>
      </p>
    </div>
  );
}
