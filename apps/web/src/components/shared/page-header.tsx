import * as React from 'react';
import { cn } from '@/lib/utils';

interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface PageHeaderProps {
  title: string;
  description?: string;
  breadcrumbs?: BreadcrumbItem[];
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Page title + description + breadcrumb + action buttons.
 * Used at the top of every content page for consistent hierarchy.
 */
export function PageHeader({ title, description, breadcrumbs, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('space-y-1', className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-2">
          <ol className="flex items-center gap-1.5 text-sm text-[var(--color-muted)]">
            {breadcrumbs.map((item, index) => (
              <li key={item.label} className="flex items-center gap-1.5">
                {index > 0 && (
                  <span className="text-[var(--color-border)]" aria-hidden="true">
                    /
                  </span>
                )}
                {item.href ? (
                  <a
                    href={item.href}
                    className="transition-colors hover:text-[var(--color-fg)]"
                  >
                    {item.label}
                  </a>
                ) : (
                  <span className="text-[var(--color-fg)]">{item.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">{title}</h1>
          {description && (
            <p className="text-sm text-[var(--color-muted)]">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
