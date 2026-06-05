'use client';

/**
 * Subscribe form, email subscription for status updates.
 * @module
 */

import { useCallback, useState } from 'react';

import { EMAIL_MAX_LENGTH } from '@/lib/validation/auth';

type FormState = 'idle' | 'submitting' | 'success' | 'error';

export function SubscribeForm() {
  const [email, setEmail] = useState('');
  const [formState, setFormState] = useState<FormState>('idle');
  const [message, setMessage] = useState('');

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (email.trim().length === 0) return;

      setFormState('submitting');
      setMessage('');

      try {
        const response = await fetch('/api/v1/status/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim() }),
        });

        const data = (await response.json()) as Record<string, unknown>;

        if (response.ok) {
          setFormState('success');
          setMessage(
            typeof data['message'] === 'string' ? data['message'] : 'Subscribed successfully.',
          );
          setEmail('');
        } else {
          setFormState('error');
          const errorData = data['error'];
          const errorMessage =
            typeof errorData === 'object' && errorData !== null && 'message' in errorData
              ? String((errorData as Record<string, unknown>)['message'])
              : 'Something went wrong. Please try again.';
          setMessage(errorMessage);
        }
      } catch {
        setFormState('error');
        setMessage('Network error. Please try again.');
      }
    },
    [email],
  );

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <h3 className="text-sm font-semibold text-[var(--color-fg)]">Subscribe to Updates</h3>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Get notified when Crivacy creates, updates, or resolves an incident.
      </p>

      <form noValidate onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (formState !== 'idle' && formState !== 'submitting') {
              setFormState('idle');
              setMessage('');
            }
          }}
          placeholder="you@example.com"
          required
          maxLength={EMAIL_MAX_LENGTH}
          disabled={formState === 'submitting'}
          className="flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder-[var(--color-muted)] outline-none transition-colors duration-[var(--duration-fast)] focus:border-[var(--color-accent)] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={formState === 'submitting' || email.trim().length === 0}
          className="hover:bg-[var(--color-accent)]/90 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white transition-colors duration-[var(--duration-fast)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {formState === 'submitting' ? 'Subscribing...' : 'Subscribe'}
        </button>
      </form>

      {/* Feedback message */}
      {message.length > 0 && (
        <p
          className={`mt-2 text-xs ${
            formState === 'success' ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
