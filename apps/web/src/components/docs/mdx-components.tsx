/**
 * Custom MDX component mapping for the documentation site.
 *
 * Server component -- provides renderers for standard markdown elements
 * emitted by `next-mdx-remote`. Heading IDs come from `rehype-slug`;
 * this module adds anchor links next to each heading.
 * @module
 */

import type { MDXComponents } from 'mdx/types';
import Image from 'next/image';
import Link from 'next/link';
import type { ComponentPropsWithoutRef } from 'react';

import { CodeCopyButton } from './code-copy-button';
import { MermaidDiagram } from './mermaid-diagram';
import { MultiLangSnippet } from './multi-lang-snippet';

// Heading styling + anchor insertion moved to CSS + rehype
// plugins. `.docs-prose` (globals.css) provides sizes, spacing,
// and the hover-reveal "#" anchor; `rehype-slug` assigns ids and
// `rehype-autolink-headings` (behavior: 'append') injects the
// anchor link. Keeping MDX component overrides empty here means
// a heading in MDX renders as a plain `<h2 id="…">Text<a /></h2>`
// that inherits every rule from the prose surface, no per-level
// React wrapper divs fighting the theme-aware CSS.

// ---------------------------------------------------------------------------
// Code block / inline code
// ---------------------------------------------------------------------------

/**
 * Code block wrapper (`<pre>`). Shiki populates `data-language` on the
 * inner `<code>` element; we extract it to show a language badge.
 */
function Pre(props: ComponentPropsWithoutRef<'pre'>) {
  const { children, className, style, ...rest } = props;
  // Shiki stamps inline `style="color:…;background-color:…"` on the
  // `<pre>` when `defaultColor: false` is set. We strip the
  // background here so our `.docs-prose pre` CSS (which picks the
  // right surface per theme) wins, otherwise the block would keep
  // the light-theme parchment even in dark mode and vice versa.
  const cleanedStyle =
    style !== undefined && style !== null
      ? { ...(style as Record<string, unknown>), backgroundColor: undefined, color: undefined }
      : undefined;
  return (
    <div
      data-code-wrapper
      className="group relative my-5 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]"
    >
      <CodeCopyButton />
      <pre
        className={className}
        style={cleanedStyle as ComponentPropsWithoutRef<'pre'>['style']}
        {...rest}
      >
        {children}
      </pre>
    </div>
  );
}

function Code(props: ComponentPropsWithoutRef<'code'>) {
  const { children, className, ...rest } = props;

  // If there is a className (usually `language-xxx` from shiki) it is a code
  // block rendered inside <pre>; otherwise it is inline code.
  const isBlock = typeof className === 'string' && className.length > 0;
  const language = className?.replace(/^language-/, '') ?? null;

  if (isBlock) {
    return (
      <>
        {language && (
          <span className="absolute right-11 top-2 rounded-[var(--radius-sm)] bg-[var(--color-border)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--color-muted)] opacity-60 transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100">
            {language}
          </span>
        )}
        <code className={className} {...rest}>
          {children}
        </code>
      </>
    );
  }

  return (
    <code
      className="rounded-[var(--radius-sm)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[0.9em] text-[var(--color-accent)]"
      {...rest}
    >
      {children}
    </code>
  );
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function Anchor(props: ComponentPropsWithoutRef<'a'>) {
  const { href, children, className, ...rest } = props;
  const isExternal =
    typeof href === 'string' && (href.startsWith('http://') || href.startsWith('https://'));

  // The rehype-autolink-headings plugin appends its own anchor
  // inside every heading with `className=["heading-anchor"]`; let
  // those render through without our custom link chrome so the CSS
  // hover-reveal behaviour (see `.heading-anchor` in globals.css)
  // stays untouched.
  if (typeof className === 'string' && className.split(' ').includes('heading-anchor')) {
    return (
      <a href={href} className={className} {...rest}>
        {children}
      </a>
    );
  }

  if (isExternal) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        {...rest}
      >
        {children}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="currentColor"
          className="ml-0.5 inline-block h-3 w-3 align-baseline"
          aria-hidden="true"
        >
          <path d="M6.22 8.72a.75.75 0 0 0 1.06 1.06l5.22-5.22v1.69a.75.75 0 0 0 1.5 0v-3.5a.75.75 0 0 0-.75-.75h-3.5a.75.75 0 0 0 0 1.5h1.69L6.22 8.72Z" />
          <path d="M3.5 6.75c0-.69.56-1.25 1.25-1.25H7A.75.75 0 0 0 7 4H4.75A2.75 2.75 0 0 0 2 6.75v4.5A2.75 2.75 0 0 0 4.75 14h4.5A2.75 2.75 0 0 0 12 11.25V9a.75.75 0 0 0-1.5 0v2.25c0 .69-.56 1.25-1.25 1.25h-4.5c-.69 0-1.25-.56-1.25-1.25v-4.5Z" />
        </svg>
      </a>
    );
  }

  return (
    <Link href={href ?? '#'} className={className}>
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

// Table wrapper, adds a scroll shell around the raw `<table>` so a
// wide row never breaks the prose column. Styling of `<th>` / `<td>`
// lives in `.docs-prose` (globals.css); we only wrap here.
function Table(props: ComponentPropsWithoutRef<'table'>) {
  const { children, ...rest } = props;
  return (
    <div className="my-6 w-full overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
      <table {...rest}>{children}</table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

function MdxImage(props: ComponentPropsWithoutRef<'img'>) {
  const { src, alt, width, height, ...rest } = props;

  // next/image requires width + height or fill; MDX images often lack these.
  // When dimensions are available, use next/image for optimization.
  if (typeof src === 'string' && typeof width === 'string' && typeof height === 'string') {
    return (
      <Image
        src={src}
        alt={alt ?? ''}
        width={Number.parseInt(width, 10)}
        height={Number.parseInt(height, 10)}
        className="my-4 rounded-[var(--radius-md)]"
        {...rest}
      />
    );
  }

  // Fallback: plain responsive img
  const resolvedAlt = alt ?? '';
  return (
    // biome-ignore lint/a11y/useAltText: alt is always set from props or empty fallback
    <img
      src={src}
      alt={resolvedAlt}
      loading="lazy"
      decoding="async"
      className="my-4 max-w-full rounded-[var(--radius-md)]"
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Custom MDX component mapping. Pass this to
 * `<MDXRemote components={mdxComponents} />`. Only elements that
 * need custom logic are listed, everything else falls through to
 * the browser default and picks up `.docs-prose` styling (see
 * `globals.css`).
 *
 *   `pre` , wraps the code block with the copy button
 *   `code`, renders a language badge for fenced blocks
 *   `a`   , routes internal hrefs through Next's `<Link>` and
 *            decorates external links with an open-in-new-tab icon
 *   `table`, wraps tables in a horizontal-scroll shell
 *   `img` , opts into `next/image` optimisation when possible
 */
export const mdxComponents: MDXComponents = {
  pre: Pre,
  code: Code,
  a: Anchor,
  table: Table,
  img: MdxImage,
  // Authored as `<Mermaid code={`sequenceDiagram …`} />` inside
  // MDX. Keeps the source in the MDX file for `grep`-ability
  // while dodging the pipeline-level complexity of transforming
  // fenced code blocks into JSX.
  Mermaid: MermaidDiagram,
  // Multi-language code samples for OAuth integration steps.
  // Authored as `<MultiLangSnippet step="callback" />` etc.
  // Reads from `lib/integration/multi-lang-templates.ts`, same
  // single source the dashboard quickstart drawer consumes.
  MultiLangSnippet,
};
