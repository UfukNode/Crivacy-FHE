'use client';

/**
 * JSON editor, thin wrapper over CodeMirror 6 with the JSON language
 * extension and a small, project-theme-friendly style surface.
 *
 * Why a component: the playground request-body field was a plain
 * `<Textarea>` which gave no indication of JSON structure, left typos
 * invisible until submit time, and rendered nested objects as a wall
 * of text. Real API testing tools use a proper code editor for this
 * slot; CodeMirror 6 is the industry baseline (VSCode is Monaco,
 * which is much heavier, CodeMirror is the right weight/feature
 * balance for a dashboard playground).
 *
 * Controlled-component API. The caller owns the string and reads
 * `onChange` for each keystroke. Parse errors, validation, and
 * submission all stay in the parent, this component only handles
 * rendering + syntax highlighting.
 *
 * Lazy-loaded from the playground page via `next/dynamic` so the
 * CodeMirror bundle (~200 KB gzipped) doesn't inflate every
 * dashboard route.
 */

import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';

import { cn } from '@/lib/utils';

export interface JsonEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Minimum editor height in rem units. Default 12 (~192px). */
  minHeightRem?: number;
  /** Visual placeholder shown when the buffer is empty. */
  placeholder?: string;
  /** Read-only rendering for code previews. */
  readOnly?: boolean;
  /** Aria label, required when the editor stands alone without a visible label. */
  ariaLabel?: string;
  className?: string;
}

export function JsonEditor({
  value,
  onChange,
  minHeightRem = 12,
  placeholder,
  readOnly = false,
  ariaLabel,
  className,
}: JsonEditorProps) {
  // Extension array is memoised so CodeMirror isn't re-initialised on
  // every parent re-render, the `json()` extension is cheap to build
  // but the editor instance caches keymaps, DOM nodes, etc., and
  // identity churn forces a teardown/rebuild cycle every keystroke.
  const extensions = useMemo(() => [json()], []);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)]',
        className,
      )}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        minHeight={`${String(minHeightRem)}rem`}
        readOnly={readOnly}
        theme="dark"
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {})}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: !readOnly,
          highlightActiveLineGutter: !readOnly,
          autocompletion: false,
        }}
      />
    </div>
  );
}
