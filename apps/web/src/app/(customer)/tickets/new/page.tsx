'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { FormField } from '@/components/shared/form-field';
import { LoadingButton } from '@/components/shared/loading-button';
import { useTicketCategories } from '@/hooks/use-ticket-categories';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const SUBJECT_MAX_LENGTH = 200;
const MESSAGE_MAX_LENGTH = 5000;

/* -------------------------------------------------------------------------- */
/*  Form validation                                                           */
/* -------------------------------------------------------------------------- */

interface FormErrors {
  readonly categoryId?: string;
  readonly subject?: string;
  readonly message?: string;
}

function validate(categoryId: string, subject: string, message: string): FormErrors {
  const errors: Record<string, string> = {};

  if (!categoryId) {
    errors['categoryId'] = 'Please select a category.';
  }
  if (!subject.trim()) {
    errors['subject'] = 'Subject is required.';
  } else if (subject.trim().length < 5) {
    errors['subject'] = 'Subject must be at least 5 characters.';
  } else if (subject.length > SUBJECT_MAX_LENGTH) {
    errors['subject'] = `Subject must be at most ${SUBJECT_MAX_LENGTH} characters.`;
  }
  if (!message.trim()) {
    errors['message'] = 'Message is required.';
  } else if (message.trim().length < 10) {
    errors['message'] = 'Message must be at least 10 characters.';
  } else if (message.length > MESSAGE_MAX_LENGTH) {
    errors['message'] = `Message must be at most ${MESSAGE_MAX_LENGTH} characters.`;
  }

  return errors as FormErrors;
}

function hasErrors(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/* -------------------------------------------------------------------------- */
/*  Content skeleton (header always renders static, sektör pattern)          */
/* -------------------------------------------------------------------------- */

function NewTicketContentSkeleton() {
  return <Skeleton className="h-96 max-w-2xl" />;
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Create new support ticket page.
 *
 * Form with:
 * - Category select (fetched from API)
 * - Subject input (max 200 chars)
 * - Message textarea (max 5000 chars)
 * - Submit with validation + loading state
 *
 * On success, redirects to the created ticket's detail page.
 */
export default function NewTicketPage() {
  const router = useRouter();
  const {
    categories,
    isLoading: categoriesLoading,
    error: categoriesError,
  } = useTicketCategories();

  const [categoryId, setCategoryId] = React.useState('');
  const [subject, setSubject] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [errors, setErrors] = React.useState<FormErrors>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  /* ---------------------------------------------------------------------- */
  /*  Submit handler                                                        */
  /* ---------------------------------------------------------------------- */

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitError(null);

    const validationErrors = validate(categoryId, subject, message);
    setErrors(validationErrors);
    if (hasErrors(validationErrors)) {
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/customer/tickets', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          categoryId,
          subject: subject.trim(),
          body: message.trim(),
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = body['error'] as Record<string, unknown> | undefined;
        const errMessage =
          (err?.['message'] as string | undefined) ?? 'Failed to create ticket. Please try again.';
        setSubmitError(errMessage);
        return;
      }

      const data = (await res.json()) as { readonly ticket: { readonly id: string } };
      router.push(`/tickets/${data.ticket.id}`);
    } catch {
      setSubmitError('Network error. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Render                                                                */
  /* ---------------------------------------------------------------------- */

  return (
    <div className="space-y-6">
      {/* Header, static, rendered immediately so the user lands on a known
          page even before the category list resolves. */}
      <div className="space-y-1">
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link href="/tickets">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to Tickets
          </Link>
        </Button>
        <h1 className="text-2xl font-bold text-[var(--color-fg)]">New Ticket</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Describe your issue and our support team will get back to you.
        </p>
      </div>

      {categoriesLoading ? (
        <NewTicketContentSkeleton />
      ) : (
        <>
          {/* Form */}
          <Card>
            <CardContent className="pt-6">
              {/* Server / categories error */}
              {categoriesError && (
                <div className="border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 mb-4 rounded-[var(--radius-sm)] border px-3 py-2 text-sm text-[var(--color-danger)]">
                  Failed to load categories. Please refresh the page.
                </div>
              )}

              {submitError !== null && (
                <div className="border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 mb-4 rounded-[var(--radius-sm)] border px-3 py-2 text-sm text-[var(--color-danger)]">
                  {submitError}
                </div>
              )}

              <form
                noValidate
                onSubmit={(e) => {
                  void handleSubmit(e);
                }}
                className="space-y-5"
              >
                {/* Category */}
                <FormField
                  label="Category"
                  htmlFor="ticket-category"
                  error={errors.categoryId}
                  required
                >
                  <Select
                    value={categoryId}
                    onValueChange={(value) => {
                      setCategoryId(value);
                      if (errors.categoryId) {
                        setErrors((prev) => {
                          const { categoryId: _, ...rest } = prev as Record<string, string>;
                          return rest as FormErrors;
                        });
                      }
                    }}
                  >
                    <SelectTrigger
                      id="ticket-category"
                      aria-describedby={errors.categoryId ? 'ticket-category-error' : undefined}
                      aria-invalid={errors.categoryId ? true : undefined}
                    >
                      <SelectValue placeholder="Select a category" />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((cat) => (
                        <SelectItem key={cat.id} value={cat.id}>
                          {cat.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>

                {/* Subject */}
                <FormField
                  label="Subject"
                  htmlFor="ticket-subject"
                  error={errors.subject}
                  description={`${subject.length}/${SUBJECT_MAX_LENGTH} characters`}
                  required
                >
                  <Input
                    id="ticket-subject"
                    value={subject}
                    onChange={(e) => {
                      setSubject(e.target.value);
                      if (errors.subject) {
                        setErrors((prev) => {
                          const { subject: _, ...rest } = prev as Record<string, string>;
                          return rest as FormErrors;
                        });
                      }
                    }}
                    maxLength={SUBJECT_MAX_LENGTH}
                    placeholder="Brief description of your issue"
                    aria-describedby={errors.subject ? 'ticket-subject-error' : undefined}
                    aria-invalid={errors.subject ? true : undefined}
                  />
                </FormField>

                {/* Message */}
                <FormField
                  label="Message"
                  htmlFor="ticket-message"
                  error={errors.message}
                  description={`${message.length}/${MESSAGE_MAX_LENGTH} characters`}
                  required
                >
                  <textarea
                    id="ticket-message"
                    value={message}
                    onChange={(e) => {
                      setMessage(e.target.value);
                      if (errors.message) {
                        setErrors((prev) => {
                          const { message: _, ...rest } = prev as Record<string, string>;
                          return rest as FormErrors;
                        });
                      }
                    }}
                    maxLength={MESSAGE_MAX_LENGTH}
                    rows={6}
                    placeholder="Describe your issue in detail..."
                    aria-describedby={errors.message ? 'ticket-message-error' : undefined}
                    aria-invalid={errors.message ? true : undefined}
                    className={cn(
                      'flex w-full resize-y rounded-[var(--radius-md)] border border-[var(--color-border)] bg-transparent px-3 py-2 text-base text-[var(--color-fg)] shadow-[var(--shadow-sm)] transition-colors duration-[var(--duration-base)] placeholder:text-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm',
                      errors.message && 'border-[var(--color-danger)]',
                    )}
                  />
                </FormField>

                {/* Actions */}
                <div className="flex items-center justify-end gap-3 pt-2">
                  <Button variant="outline" type="button" asChild disabled={submitting}>
                    <Link href="/tickets">Cancel</Link>
                  </Button>
                  <LoadingButton type="submit" loading={submitting}>
                    Create Ticket
                  </LoadingButton>
                </div>
              </form>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
