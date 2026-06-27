'use client';

/**
 * Single expandable integration spec card. Click the header to toggle
 * the content panel. Each card runs its own `useState` so the user
 * can keep multiple open at once when comparing snippets.
 *
 * Wraps server pre rendered content children so the snippet bodies
 * (`MultiLangSnippet`, `CodeBlock`) keep their own state.
 */

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

interface ExpandableSpecProps {
  readonly icon: React.ReactNode;
  readonly eyebrow: string;
  readonly title: string;
  readonly summary: React.ReactNode;
  readonly defaultOpen?: boolean;
  readonly children: React.ReactNode;
}

export function ExpandableSpec({
  icon,
  eyebrow,
  title,
  summary,
  defaultOpen = false,
  children,
}: ExpandableSpecProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border bg-stone-900/30 transition-colors',
        open ? 'border-stone-700' : 'border-stone-800',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-start gap-4 px-5 py-5 text-left transition-colors hover:bg-stone-900/50"
      >
        <span
          aria-hidden
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-stone-900/80 transition-colors',
            open
              ? 'border-[#cc785c]/40 text-[#cc785c]'
              : 'border-stone-800 text-stone-400',
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
              {eyebrow}
            </span>
          </div>
          <p className="mt-1 font-serif text-[16px] font-normal tracking-tight text-stone-50">
            {title}
          </p>
          <p className="mt-1.5 text-[12.5px] leading-[1.7] text-stone-400">{summary}</p>
        </div>
        <span
          aria-hidden
          className={cn(
            'mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-stone-500 transition-transform',
            open ? 'rotate-180 text-stone-300' : 'rotate-0',
          )}
        >
          <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
        </span>
      </button>
      {open ? (
        <div className="border-t border-stone-800/80 bg-stone-950/30 px-5 py-5">{children}</div>
      ) : null}
    </div>
  );
}
