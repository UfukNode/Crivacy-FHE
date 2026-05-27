'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LoadingButton } from '@/components/shared/loading-button';
import {
  useFirmTicketAction,
  useFirmTicketCategories,
} from '@/hooks/use-firm-tickets';

const SUBJECT_MAX = 200;
const BODY_MAX = 5000;

export default function NewFirmTicketPage() {
  const router = useRouter();
  const { categories, isLoading: catsLoading } = useFirmTicketCategories();
  const { execute } = useFirmTicketAction();

  const [categoryId, setCategoryId] = React.useState<string>('');
  const [subject, setSubject] = React.useState('');
  const [body, setBody] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    const trimmedSubject = subject.trim();
    const trimmedBody = body.trim();

    if (categoryId.length === 0) {
      setError('Please choose a category.');
      return;
    }
    if (trimmedSubject.length === 0) {
      setError('Please enter a subject.');
      return;
    }
    if (trimmedBody.length === 0) {
      setError('Please describe your issue.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await execute('/api/internal/tickets', {
        method: 'POST',
        body: { categoryId, subject: trimmedSubject, body: trimmedBody },
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = payload['error'] as Record<string, unknown> | undefined;
        setError((err?.['message'] as string | undefined) ?? 'Failed to open ticket.');
        return;
      }
      const created = (await res.json()) as { id: string };
      router.push(`/dashboard/tickets/${created.id}`);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/dashboard/tickets">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to Tickets
          </Link>
        </Button>
        <h1 className="mt-2 text-xl font-bold text-[var(--color-fg)]">Open a ticket</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Our support team will reply in-app and by email. Any teammate can
          follow up on this thread.
        </p>
      </div>

      <Card>
        <CardContent className="p-6">
          <form noValidate onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-category">Category</Label>
              <Select
                value={categoryId}
                onValueChange={setCategoryId}
                disabled={catsLoading || submitting}
              >
                <SelectTrigger id="new-category">
                  <SelectValue
                    placeholder={catsLoading ? 'Loading…' : 'Choose a category'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((cat) => (
                    <SelectItem key={cat.id} value={cat.id}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-subject">Subject</Label>
              <Input
                id="new-subject"
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value);
                }}
                maxLength={SUBJECT_MAX}
                placeholder="Short summary of the issue"
                disabled={submitting}
                required
              />
              <p className="text-right text-xs text-[var(--color-muted)]">
                {subject.length}/{SUBJECT_MAX}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-body">Describe your issue</Label>
              <textarea
                id="new-body"
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                }}
                maxLength={BODY_MAX}
                rows={8}
                placeholder="Include any relevant error messages, request IDs, or steps to reproduce."
                disabled={submitting}
                required
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] disabled:opacity-60"
              />
              <p className="text-right text-xs text-[var(--color-muted)]">
                {body.length}/{BODY_MAX}
              </p>
            </div>

            {error !== null && (
              <div
                role="alert"
                className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]"
              >
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" asChild disabled={submitting}>
                <Link href="/dashboard/tickets">Cancel</Link>
              </Button>
              <LoadingButton
                type="submit"
                loading={submitting}
                disabled={
                  categoryId.length === 0 || subject.trim().length === 0 || body.trim().length === 0
                }
              >
                Open ticket
              </LoadingButton>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
