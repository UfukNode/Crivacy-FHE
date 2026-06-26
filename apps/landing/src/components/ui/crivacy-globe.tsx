"use client";

import createGlobe from "cobe";
import { useEffect, useRef } from "react";

import { useTheme } from "@/components/theme-provider";
import { CrivacyLogoMark } from "@/components/ui/crivacy-logo-mark";
import { cn } from "@/lib/utils";
import { useThemeColors } from "@/lib/use-theme-colors";

/**
 * Crivacy globe — cobe v2 "bars" showcase base, themed with runtime CSS tokens:
 *   - No hardcoded colors. All colors resolve from `useThemeColors()` (which
 *     reads `tokens.css`) + direct `var(--*)` references in the inline style.
 *   - Theme-aware: rebuilds globe whenever token values flip (dark/light).
 *   - Each marker overlay shows a Crivacy logo mark (SVG, currentColor).
 *   - Bar lifecycle cycles: VERIFYING (0 → 100%, brand accent) → VERIFIED
 *     (hold, functional success green) → restart. Staggered per marker.
 *
 * Uses CSS anchor positioning (Chrome 125+, Edge 125+). cobe v2 emits
 * `anchor-name: --cobe-{id}` anchor divs + `--cobe-visible-{id}` CSS
 * custom property per marker; our overlays hook into those.
 */

// Each marker gets a Crivacy logo overlay + verification bar. Coordinates are
// chosen so that every pair has either >25° latitude OR >25° longitude
// separation — enough that bars (min-width 78px) never visually collide at the
// default 560px canvas.
const BAR_MARKERS = [
  { id: "bar-1", location: [40.71, -74.01] as [number, number], label: "NYC" },
  { id: "bar-2", location: [51.51, -0.13] as [number, number], label: "LONDON" },
  { id: "bar-3", location: [35.68, 139.65] as [number, number], label: "TOKYO" },
  { id: "bar-4", location: [1.35, 103.82] as [number, number], label: "SINGAPORE" },
  { id: "bar-5", location: [37.77, -122.42] as [number, number], label: "SFO" },
  { id: "bar-6", location: [-23.55, -46.63] as [number, number], label: "SAO PAULO" },
  { id: "bar-7", location: [25.2, 55.27] as [number, number], label: "DUBAI" },
  { id: "bar-8", location: [-33.87, 151.21] as [number, number], label: "SYDNEY" },
  { id: "bar-9", location: [41.01, 28.98] as [number, number], label: "ISTANBUL" },
  { id: "bar-10", location: [6.52, 3.38] as [number, number], label: "LAGOS" },
  { id: "bar-11", location: [-26.2, 28.04] as [number, number], label: "JOBURG" },
];

// Bar lifecycle
const VERIFY_MS = 3500;
const VERIFIED_HOLD_MS = 2200;
const CYCLE_MS = VERIFY_MS + VERIFIED_HOLD_MS;
const STAGGER_MS = CYCLE_MS / BAR_MARKERS.length;

// cobe v2 extras not in the v1 TS types
type CobeExtra = {
  markerElevation?: number;
  arcs?: unknown[];
  arcColor?: [number, number, number];
  arcWidth?: number;
  arcHeight?: number;
  opacity?: number;
};

// Parse `#rrggbb` → cobe's normalized `[r, g, b]` floats
function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace("#", "").trim();
  if (h.length !== 6) return [0, 0, 0];
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
  ];
}

export function CrivacyGlobe({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const barFillRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const statusRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const { theme } = useTheme();
  const colors = useThemeColors();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let phi = 0;
    const width = canvas.offsetWidth;
    const dpr = Math.min(
      window.devicePixelRatio || 1,
      window.innerWidth < 640 ? 1.8 : 2,
    );

    const markers = BAR_MARKERS.map((m) => ({
      location: m.location,
      size: 0.02,
      id: m.id,
    }));

    const isDark = theme === "dark";

    // Resolve all cobe WebGL colors from tokens (no hardcoded values)
    const bgRgb = hexToRgb01(colors.bgPrimary);
    const accentRgb = hexToRgb01(colors.accentPrimary);
    const bgTertiaryRgb = hexToRgb01(colors.bgTertiary);
    const glow: [number, number, number] = isDark
      ? [accentRgb[0] * 0.32, accentRgb[1] * 0.32, accentRgb[2] * 0.22]
      : [accentRgb[0] * 0.6, accentRgb[1] * 0.6, accentRgb[2] * 0.5];

    const cobeOptions: Parameters<typeof createGlobe>[1] & CobeExtra = {
      devicePixelRatio: dpr,
      width: width * dpr,
      height: width * dpr,
      phi: 0,
      theta: 0.25,
      dark: isDark ? 1 : 0,
      diffuse: 1.5,
      mapSamples: 16000,
      mapBrightness: isDark ? 12 : 10,
      baseColor: isDark ? bgRgb : bgTertiaryRgb,
      markerColor: isDark ? accentRgb : accentRgb,
      glowColor: glow,
      markerElevation: 0,
      markers,
      arcs: [],
      arcColor: isDark ? accentRgb : accentRgb,
      arcWidth: 0.5,
      arcHeight: 0.25,
      opacity: isDark ? 0.7 : 0.85,
    };

    const globe = createGlobe(canvas, cobeOptions);

    // Pointer drag interaction — desktop only. On mobile (<640px) the globe
    // is non-interactive so the user can scroll past it.
    let pointerInteracting: number | null = null;
    let pointerMovement = 0;
    const isMobile = window.innerWidth < 640;

    if (!isMobile) {
      const onPointerDown = (e: PointerEvent) => {
        canvas.setPointerCapture(e.pointerId);
        pointerInteracting = e.clientX - pointerMovement;
        canvas.style.cursor = "grabbing";
      };
      const onPointerUp = (e: PointerEvent) => {
        if (canvas.hasPointerCapture(e.pointerId)) {
          canvas.releasePointerCapture(e.pointerId);
        }
        pointerInteracting = null;
        canvas.style.cursor = "grab";
      };
      const onPointerMove = (e: PointerEvent) => {
        if (pointerInteracting !== null) {
          pointerMovement = e.clientX - pointerInteracting;
        }
      };

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      canvas.addEventListener("pointermove", onPointerMove);

      // Store for cleanup
      (canvas as unknown as Record<string, unknown>).__globeCleanup = () => {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerUp);
        canvas.removeEventListener("pointermove", onPointerMove);
      };
    } else {
      canvas.style.touchAction = "auto";
      canvas.style.cursor = "default";
      canvas.style.pointerEvents = "none";
    }

    // Seed staggered start times so markers are out of phase
    const t0 = performance.now();
    const startTimes = BAR_MARKERS.map((_, i) => t0 - i * STAGGER_MS);

    let frameId = 0;
    const animate = (t: number) => {
      if (pointerInteracting === null) {
        phi += 0.003;
      }
      globe.update({ phi: phi + pointerMovement / 200, markers });

      // Update each bar's lifecycle
      for (let i = 0; i < BAR_MARKERS.length; i++) {
        let elapsed = t - startTimes[i]!;
        if (elapsed >= CYCLE_MS) {
          startTimes[i] = t;
          elapsed = 0;
        }

        const verified = elapsed >= VERIFY_MS;
        const progress = verified ? 100 : (elapsed / VERIFY_MS) * 100;
        const phase = verified ? "verified" : "verifying";

        const fillEl = barFillRefs.current[i];
        if (fillEl) {
          fillEl.style.width = `${progress}%`;
          if (fillEl.dataset.phase !== phase) {
            fillEl.dataset.phase = phase;
          }
        }

        const statusEl = statusRefs.current[i];
        if (statusEl) {
          const text = verified ? "VERIFIED" : "VERIFYING";
          if (statusEl.textContent !== text) {
            statusEl.textContent = text;
            statusEl.dataset.phase = phase;
          }
        }
      }

      frameId = requestAnimationFrame(animate);
    };
    frameId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(frameId);
      const cleanup = (canvas as unknown as Record<string, unknown>).__globeCleanup as (() => void) | undefined;
      cleanup?.();
      globe.destroy();
    };
  }, [theme, colors.accentPrimary, colors.bgPrimary]);

  return (
    <div
      className={cn(
        "relative mx-auto aspect-square w-full max-w-[560px]",
        className,
      )}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          contain: "layout paint size",
          cursor: "grab",
          touchAction: "none",
        }}
      />

      {/* Crivacy logo markers — sit on the globe surface, cover cobe's dots */}
      {BAR_MARKERS.map((m) => (
        <div
          key={`logo-${m.id}`}
          className="crivacy-marker-logo"
          style={
            {
              positionAnchor: `--cobe-${m.id}`,
              opacity: `var(--cobe-visible-${m.id}, 0)`,
              filter: `blur(calc((1 - var(--cobe-visible-${m.id}, 0)) * 8px))`,
            } as React.CSSProperties
          }
        >
          <CrivacyLogoMark />
        </div>
      ))}

      {/* Bar overlays — lifecycle-driven analytics above each marker */}
      {BAR_MARKERS.map((m, i) => (
        <div
          key={m.id}
          className="crivacy-bar"
          style={
            {
              positionAnchor: `--cobe-${m.id}`,
              opacity: `var(--cobe-visible-${m.id}, 0)`,
              filter: `blur(calc((1 - var(--cobe-visible-${m.id}, 0)) * 8px))`,
            } as React.CSSProperties
          }
        >
          <span className="crivacy-bar-label">{m.label}</span>
          <span className="crivacy-bar-track">
            <span
              ref={(el) => {
                barFillRefs.current[i] = el;
              }}
              className="crivacy-bar-fill"
              data-phase="verifying"
              style={{ width: "0%" }}
            />
          </span>
          <span
            ref={(el) => {
              statusRefs.current[i] = el;
            }}
            className="crivacy-bar-status"
            data-phase="verifying"
          >
            VERIFYING
          </span>
        </div>
      ))}

      <style>{`
        /* ── Crivacy logo marker ──────────────────── */
        .crivacy-marker-logo {
          position: absolute;
          top: anchor(center);
          left: anchor(center);
          translate: -50% -50%;
          width: 20px;
          height: 20px;
          color: var(--accent-contrast);
          transition: color 0.26s ease;
          pointer-events: none;
        }
        .crivacy-marker-logo svg {
          width: 100%;
          height: 100%;
        }
        [data-theme="dark"] .crivacy-marker-logo {
          color: color-mix(in srgb, var(--accent-primary) 85%, transparent);
        }
        [data-theme="light"] .crivacy-marker-logo {
          color: var(--accent-primary);
        }

        /* ── Bar overlay ──────────────────────────── */
        .crivacy-bar {
          position: absolute;
          bottom: anchor(top);
          left: anchor(center);
          translate: -50% 0;
          margin-bottom: 26px;
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 0.22rem;
          padding: 0.35rem 0.5rem;
          background: color-mix(in srgb, var(--bg-primary) 72%, transparent);
          border: 1px solid var(--accent-border);
          border-radius: 3px;
          min-width: 78px;
          pointer-events: none;
          backdrop-filter: blur(2px);
          transition: background 0.26s ease, border-color 0.26s ease;
        }
        [data-theme="light"] .crivacy-bar {
          background: var(--bg-elevated);
        }

        .crivacy-bar-label {
          font-family: var(--font-mono), monospace;
          font-size: 0.5rem;
          font-weight: 600;
          letter-spacing: 0.12em;
          text-align: center;
          color: var(--text-secondary);
          transition: color 0.26s ease;
        }

        .crivacy-bar-track {
          width: 100%;
          height: 5px;
          background: var(--border-subtle);
          border-radius: 3px;
          overflow: hidden;
          transition: background 0.26s ease;
        }

        .crivacy-bar-fill {
          display: block;
          height: 100%;
          width: 0%;
          background: var(--accent-primary);
          border-radius: 3px;
          transition: background 0.35s ease;
        }
        .crivacy-bar-fill[data-phase="verified"] {
          background: var(--state-success);
        }

        .crivacy-bar-status {
          font-family: var(--font-mono), monospace;
          font-size: 0.48rem;
          font-weight: 600;
          letter-spacing: 0.14em;
          text-align: center;
          color: var(--accent-primary);
          transition: color 0.35s ease;
        }
        .crivacy-bar-status[data-phase="verified"] {
          color: var(--state-success);
        }
      `}</style>
    </div>
  );
}
