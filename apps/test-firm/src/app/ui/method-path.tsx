/**
 * MethodPath. Inline badge that pairs an HTTP verb pill with a mono
 * path code. Used wherever the dApp surfaces an endpoint reference in
 * prose so the verb does not flatten into normal text.
 */

import { cn } from '@/lib/utils';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface MethodPathProps {
  readonly method: Method;
  readonly path: string;
  readonly className?: string;
}

const METHOD_TONE: Readonly<Record<Method, string>> = {
  GET: 'border-sky-900/60 bg-sky-950/40 text-sky-300',
  POST: 'border-emerald-900/60 bg-emerald-950/40 text-emerald-300',
  PUT: 'border-amber-900/60 bg-amber-950/40 text-amber-300',
  PATCH: 'border-amber-900/60 bg-amber-950/40 text-amber-300',
  DELETE: 'border-rose-900/60 bg-rose-950/40 text-rose-300',
};

export function MethodPath({ method, path, className }: MethodPathProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 align-middle font-mono',
        className,
      )}
    >
      <span
        className={cn(
          'inline-flex items-center rounded border px-1.5 py-[1px] text-[10px] font-semibold uppercase leading-none tracking-[0.06em]',
          METHOD_TONE[method],
        )}
      >
        {method}
      </span>
      <code className="rounded border border-stone-800 bg-stone-950/60 px-1.5 py-[1px] text-[11.5px] leading-none text-stone-200">
        {path}
      </code>
    </span>
  );
}
