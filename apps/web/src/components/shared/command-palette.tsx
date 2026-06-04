'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import type { LucideIcon } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandEntry {
  readonly label: string;
  readonly href?: string;
  readonly action?: () => void;
  readonly icon: LucideIcon;
  readonly group: 'navigation' | 'actions';
  readonly keywords?: readonly string[];
}

interface CommandPaletteProps {
  readonly commands: readonly CommandEntry[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Global command palette accessible via Cmd+K (Mac) or Ctrl+K (Windows).
 *
 * Renders a fuzzy-searchable dialog with navigation links and contextual
 * actions. The keyboard shortcut is suppressed when the user is focused
 * inside an input, textarea, or content-editable element.
 */
export function CommandPalette({ commands }: CommandPaletteProps) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleSelect = React.useCallback(
    (entry: CommandEntry) => {
      setOpen(false);
      if (entry.href !== undefined) {
        router.push(entry.href);
      } else if (entry.action !== undefined) {
        entry.action();
      }
    },
    [router],
  );

  const navCommands = React.useMemo(
    () => commands.filter((c) => c.group === 'navigation'),
    [commands],
  );
  const actionCommands = React.useMemo(
    () => commands.filter((c) => c.group === 'actions'),
    [commands],
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {navCommands.length > 0 && (
          <CommandGroup heading="Navigation">
            {navCommands.map((cmd) => {
              const Icon = cmd.icon;
              const keywordProps = cmd.keywords !== undefined
                ? { keywords: [...cmd.keywords] }
                : {};
              return (
                <CommandItem
                  key={cmd.label}
                  onSelect={() => handleSelect(cmd)}
                  {...keywordProps}
                >
                  <Icon className="mr-2 h-4 w-4" aria-hidden="true" />
                  <span>{cmd.label}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        {actionCommands.length > 0 && (
          <CommandGroup heading="Actions">
            {actionCommands.map((cmd) => {
              const Icon = cmd.icon;
              const keywordProps = cmd.keywords !== undefined
                ? { keywords: [...cmd.keywords] }
                : {};
              return (
                <CommandItem
                  key={cmd.label}
                  onSelect={() => handleSelect(cmd)}
                  {...keywordProps}
                >
                  <Icon className="mr-2 h-4 w-4" aria-hidden="true" />
                  <span>{cmd.label}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
