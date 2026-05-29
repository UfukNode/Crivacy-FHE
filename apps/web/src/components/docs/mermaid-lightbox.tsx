'use client';

/**
 * Fullscreen zoom + pan lightbox for a rendered Mermaid SVG.
 *
 * Zero-dep: a transform wrapper around the SVG markup with its
 * own wheel / pointer handlers. Matches the UX users expect from
 * mermaid.live and the GitHub diagram viewer:
 *
 *   * Ctrl/Cmd + wheel, or plain wheel over the canvas → zoom,
 *     centred on the cursor.
 *   * `+` / `−` / `0` (reset) buttons for keyboard-free control.
 *   * Pointer drag → pan.
 *   * Esc, the `×` button, or any click on the backdrop → close.
 *
 * Portalled to `document.body` so the fixed overlay escapes the
 * docs header (which sets `backdrop-filter` and would otherwise
 * become the containing block for `position: fixed`).
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { createPortal } from 'react-dom';

export interface MermaidLightboxProps {
  readonly svg: string;
  readonly caption?: string;
  readonly onClose: () => void;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;

export function MermaidLightbox({ svg, caption, onClose }: MermaidLightboxProps) {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Read the SVG's natural dimensions from (in order) its
  // `width`/`height` attributes, its `viewBox`, or, as a last
  // resort, the browser-computed `getBoundingClientRect`. This
  // lets us give the transform wrapper an explicit pixel size so
  // it doesn't collapse into a zero-size shrink-wrap loop with
  // the SVG's `max-width: 100%` inline style (which Mermaid
  // stamps on every output).
  useEffect(() => {
    if (!isMounted) return;
    const content = contentRef.current;
    if (content === null) return;
    const svgEl = content.querySelector('svg');
    if (svgEl === null) return;

    let width = Number.parseFloat(svgEl.getAttribute('width') ?? '') || 0;
    let height = Number.parseFloat(svgEl.getAttribute('height') ?? '') || 0;
    if (width === 0 || height === 0) {
      const viewBox = svgEl.getAttribute('viewBox');
      if (viewBox !== null) {
        const parts = viewBox.split(/\s+/).map(Number);
        width = parts[2] ?? 0;
        height = parts[3] ?? 0;
      }
    }
    if (width === 0 || height === 0) {
      const rect = svgEl.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
    }
    if (width === 0 || height === 0) return;

    // Force the SVG to fill the wrapper we're about to size, bypasses
    // Mermaid's own `max-width: 100%` inline style.
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', '100%');
    svgEl.style.maxWidth = 'none';
    svgEl.style.maxHeight = 'none';
    svgEl.style.display = 'block';
    svgEl.style.width = '100%';
    svgEl.style.height = '100%';

    setBox({ width, height });
  }, [isMounted, svg]);

  // Fit-to-canvas once the natural SVG box is known.
  useEffect(() => {
    if (box === null) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const fit = Math.min((rect.width * 0.9) / box.width, (rect.height * 0.9) / box.height);
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fit));
    setScale(clamped);
    setTranslate({ x: 0, y: 0 });
  }, [box]);

  // Lock background scroll + honour Esc while open.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        setScale((s) => Math.min(MAX_ZOOM, s * ZOOM_STEP));
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        setScale((s) => Math.max(MIN_ZOOM, s / ZOOM_STEP));
      } else if (e.key === '0') {
        e.preventDefault();
        setScale(1);
        setTranslate({ x: 0, y: 0 });
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  // Wheel zoom, anchors on the cursor so the point under the
  // pointer stays put while the canvas scales, same as Figma /
  // Google Maps. Attached as a native non-passive listener
  // because React's synthetic `onWheel` is passive by default,
  // which makes `preventDefault` a no-op (and Chrome warns
  // about it).
  useEffect(() => {
    if (!isMounted) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;

    function handleWheel(e: WheelEvent): void {
      e.preventDefault();
      const el = canvasRef.current;
      if (el === null) return;
      const rect = el.getBoundingClientRect();
      const pointerX = e.clientX - rect.left - rect.width / 2;
      const pointerY = e.clientY - rect.top - rect.height / 2;

      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setScale((prev) => {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev * factor));
        const ratio = next / prev;
        setTranslate((t) => ({
          x: pointerX - (pointerX - t.x) * ratio,
          y: pointerY - (pointerY - t.y) * ratio,
        }));
        return next;
      });
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [isMounted]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { x: e.clientX, y: e.clientY, tx: translate.x, ty: translate.y };
    setIsDragging(true);
  }, [translate.x, translate.y]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (start === null) return;
    setTranslate({
      x: start.tx + (e.clientX - start.x),
      y: start.ty + (e.clientY - start.y),
    });
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStart.current === null) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragStart.current = null;
    setIsDragging(false);
  }, []);

  const reset = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  if (!isMounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)]/95 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Diagram viewer"
        className="relative flex h-full w-full flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Toolbar */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3">
          <p className="min-w-0 truncate text-sm font-medium text-[var(--color-fg)]">
            {caption ?? 'Diagram'}
          </p>
          <div className="flex items-center gap-1.5">
            <ToolbarButton onClick={() => setScale((s) => Math.max(MIN_ZOOM, s / ZOOM_STEP))} label="Zoom out" shortcut="−">
              <IconMinus />
            </ToolbarButton>
            <span className="inline-flex h-7 min-w-[3.25rem] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-bg)] px-2 font-mono text-xs text-[var(--color-muted)] tabular-nums">
              {Math.round(scale * 100)}%
            </span>
            <ToolbarButton onClick={() => setScale((s) => Math.min(MAX_ZOOM, s * ZOOM_STEP))} label="Zoom in" shortcut="+">
              <IconPlus />
            </ToolbarButton>
            <span className="mx-2 h-4 w-px bg-[var(--color-border)]" />
            <ToolbarButton onClick={reset} label="Reset" shortcut="0">
              <IconReset />
            </ToolbarButton>
            <span className="mx-2 h-4 w-px bg-[var(--color-border)]" />
            <ToolbarButton onClick={onClose} label="Close" shortcut="Esc">
              <IconClose />
            </ToolbarButton>
          </div>
        </div>

        {/* Canvas */}
        <div
          ref={canvasRef}
          className="relative flex-1 overflow-hidden select-none touch-none"
          style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div
            ref={contentRef}
            className="absolute left-1/2 top-1/2 origin-center"
            style={{
              // Pin to the SVG's intrinsic box once we've measured
              // it; before that, fall back to a reasonable default
              // so the container isn't 0×0 and the first render
              // still has something to lay out.
              width: box !== null ? `${box.width}px` : '800px',
              height: box !== null ? `${box.height}px` : '600px',
              transform: `translate(calc(-50% + ${translate.x}px), calc(-50% + ${translate.y}px)) scale(${scale})`,
              transition: isDragging ? 'none' : 'transform 80ms ease-out',
            }}
            // Mermaid SVG, emitted with `securityLevel: 'strict'`,
            // safe to inject.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>

        {/* Footer hint */}
        <div className="flex items-center justify-center gap-4 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-2 text-[11px] text-[var(--color-muted)]">
          <span className="inline-flex items-center gap-1.5">
            <Kbd>scroll</Kbd> zoom
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>drag</Kbd> pan
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>+</Kbd> <Kbd>−</Kbd> <Kbd>0</Kbd> keys
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ToolbarButton({
  onClick,
  label,
  shortcut,
  children,
}: {
  readonly onClick: () => void;
  readonly label: string;
  readonly shortcut?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={shortcut !== undefined ? `${label} (${shortcut})` : label}
      title={shortcut !== undefined ? `${label} (${shortcut})` : label}
      className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
    >
      {children}
    </button>
  );
}

function Kbd({ children }: { readonly children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-1 font-mono text-[10px] text-[var(--color-fg)]">
      {children}
    </kbd>
  );
}

function IconPlus() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
    </svg>
  );
}
function IconMinus() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M4 10a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75A.75.75 0 0 1 4 10Z" />
    </svg>
  );
}
function IconReset() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.22Z" clipRule="evenodd" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <path fillRule="evenodd" d="M4.28 3.22a.75.75 0 0 0-1.06 1.06L8.94 10l-5.72 5.72a.75.75 0 1 0 1.06 1.06L10 11.06l5.72 5.72a.75.75 0 1 0 1.06-1.06L11.06 10l5.72-5.72a.75.75 0 0 0-1.06-1.06L10 8.94 4.28 3.22Z" clipRule="evenodd" />
    </svg>
  );
}
