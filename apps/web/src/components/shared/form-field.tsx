'use client';

import * as React from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export interface FormFieldProps {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  description?: string | undefined;
  required?: boolean | undefined;
  children: React.ReactNode;
  className?: string | undefined;
}

/**
 * Label + Input + error message wrapper.
 * Wraps any input component with consistent label positioning and error display.
 */
export function FormField({
  label,
  htmlFor,
  error,
  description,
  required,
  children,
  className,
}: FormFieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <Label htmlFor={htmlFor} className={cn(error && 'text-[var(--color-danger)]')}>
        {label}
        {required && (
          <span className="ml-1 text-[var(--color-danger)]" aria-hidden="true">
            *
          </span>
        )}
      </Label>
      {children}
      {description && !error && (
        <p className="text-xs text-[var(--color-muted)]">{description}</p>
      )}
      {error && (
        <p className="text-xs text-[var(--color-danger)]" role="alert" id={`${htmlFor}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
