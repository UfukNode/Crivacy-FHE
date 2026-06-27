'use client';

/**
 * Horizontal step picker for the integration spec section. Four
 * equal cells across the top, the active one highlighted, the
 * content panel rendered underneath. Stripe Connect / Vercel docs
 * pattern.
 *
 * Each item's content is mounted once and toggled with `hidden` so
 * the inner client widgets (`MultiLangSnippet`'s language tabs,
 * `CodeBlock`'s shiki state) keep their state across step switches.
 */

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

export interface IntegrationSpecItem {
  readonly eyebrow: string;
  readonly title: string;
  readonly summary: React.ReactNode;
  readonly icon: React.ReactNode;
  readonly content: React.ReactNode;
}

interface IntegrationSpecProps {
  readonly items: readonly IntegrationSpecItem[];
  readonly defaultActive?: number;
}

export function IntegrationSpec({ items, defaultActive = 0 }: IntegrationSpecProps) {
  const [active, setActive] = useState(defaultActive);
  return (
    <div className="space-y-5">
      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item, i) => {
          const isActive = i === active;
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => setActive(i)}
                aria-pressed={isActive}
                aria-controls={`integration-spec-panel-${i}`}
                className={cn(
                  'group relative flex h-full w-full flex-col gap-3 rounded-xl border bg-stone-900/30 px-4 py-4 text-left transition-colors',
                  isActive
                    ? 'border-[#cc785c]/40 bg-stone-900/60'
                    : 'border-stone-800 hover:border-stone-700 hover:bg-stone-900/50',
                )}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    aria-hidden
                    className={cn(
                      'font-mono text-[11px] tabular-nums tracking-tight',
                      isActive ? 'text-[#cc785c]' : 'text-stone-600',
                    )}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      'h-px flex-1',
                      isActive ? 'bg-[#cc785c]/40' : 'bg-stone-800',
                    )}
                  />
                  <span
                    aria-hidden
                    className={cn(
                      'flex h-6 w-6 items-center justify-center rounded-md border bg-stone-900/80 transition-colors',
                      isActive
                        ? 'border-[#cc785c]/40 text-[#cc785c]'
                        : 'border-stone-800 text-stone-500',
                    )}
                  >
                    {item.icon}
                  </span>
                </div>
                <div className="flex min-w-0 items-end justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
                      {item.eyebrow}
                    </p>
                    <p
                      className={cn(
                        'mt-1 font-serif text-[15.5px] font-normal tracking-tight',
                        isActive ? 'text-stone-50' : 'text-stone-200',
                      )}
                    >
                      {item.title}
                    </p>
                  </div>
                  <ChevronDown
                    aria-hidden="true"
                    strokeWidth={1.75}
                    className={cn(
                      'h-4 w-4 shrink-0 transition-transform',
                      isActive ? 'rotate-180 text-[#cc785c]' : 'text-stone-600',
                    )}
                  />
                </div>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="overflow-hidden rounded-xl border border-stone-800 bg-stone-950/40">
        <div className="border-b border-stone-800/80 bg-stone-900/30 px-5 py-4 sm:px-6">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
            {items[active]?.eyebrow ?? ''}
          </p>
          <p className="mt-1 font-serif text-[18px] font-normal tracking-tight text-stone-50">
            {items[active]?.title ?? ''}
          </p>
          <p className="mt-2 max-w-2xl text-[13px] leading-[1.7] text-stone-400">
            {items[active]?.summary ?? null}
          </p>
        </div>
        <div className="px-5 py-5 sm:px-6">
          {items.map((item, i) => (
            <div
              key={i}
              id={`integration-spec-panel-${i}`}
              role="region"
              aria-labelledby={`integration-spec-step-${i}`}
              hidden={i !== active}
            >
              {item.content}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
