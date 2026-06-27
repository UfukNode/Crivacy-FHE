"use client";

import React, { useCallback, useEffect, useRef } from "react";
import {
  motion,
  useMotionTemplate,
  useMotionValue,
} from "motion/react";

import { cn } from "@/lib/utils";

// MagicCard — Magic UI hover-following radial gradient card, rewritten
// for Crivacy's data-theme system.
//
// The upstream component (magicui.design/docs/components/magic-card) pulls
// theme state via next-themes, which is NOT installed here (Crivacy has its
// own ThemeProvider that writes a `data-theme` attribute). It also defaults
// to a purple/pink gradient border, which CLAUDE.md explicitly bans.
//
// This adaptation:
//   - Drops next-themes. Theming is already handled via CSS tokens, so the
//     gradient endpoints and surface colors are resolved at paint time from
//     --accent-primary / --accent-hover / --bg-secondary / --border-default.
//   - Keeps only the "gradient" mode (the upstream "orb" variant is unused
//     and pulls in mix-blend-mode logic we don't need).
//   - The `useMotionTemplate` background is a hover SPOTLIGHT, not a static
//     background fill — the inner content sits on a solid bg-secondary
//     surface so the overall card is flat, just like the rest of the site.
interface MagicCardProps {
  children?: React.ReactNode;
  className?: string;
  gradientSize?: number;
  // Radial "spotlight" that tracks the cursor on hover.
  gradientColor?: string;
  gradientOpacity?: number;
  // Animated border gradient endpoints.
  gradientFrom?: string;
  gradientTo?: string;
}

export function MagicCard({
  children,
  className,
  gradientSize = 240,
  gradientColor = "color-mix(in srgb, var(--accent-primary) 22%, transparent)",
  gradientOpacity = 1,
  gradientFrom = "var(--accent-primary)",
  gradientTo = "var(--accent-hover)",
}: MagicCardProps) {
  const mouseX = useMotionValue(-gradientSize);
  const mouseY = useMotionValue(-gradientSize);

  const gradientSizeRef = useRef(gradientSize);
  useEffect(() => {
    gradientSizeRef.current = gradientSize;
  }, [gradientSize]);

  const reset = useCallback(() => {
    const off = -gradientSizeRef.current;
    mouseX.set(off);
    mouseY.set(off);
  }, [mouseX, mouseY]);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      mouseX.set(e.clientX - rect.left);
      mouseY.set(e.clientY - rect.top);
    },
    [mouseX, mouseY],
  );

  useEffect(() => {
    reset();
  }, [reset]);

  useEffect(() => {
    const handleGlobalPointerOut = (e: PointerEvent) => {
      if (!e.relatedTarget) reset();
    };
    const handleBlur = () => reset();
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") reset();
    };

    window.addEventListener("pointerout", handleGlobalPointerOut);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("pointerout", handleGlobalPointerOut);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [reset]);

  // Border background — two stacked gradients:
  //   1. padding-box  : a flat bg-secondary fill covering the card body
  //   2. border-box   : the animated radial spotlight, visible only through
  //                     the transparent 1px border frame
  // The result is a solid card whose border "lights up" toward the cursor.
  const borderBackground = useMotionTemplate`
    linear-gradient(var(--bg-secondary) 0 0) padding-box,
    radial-gradient(${gradientSize}px circle at ${mouseX}px ${mouseY}px,
      ${gradientFrom},
      ${gradientTo},
      var(--border-default) 100%
    ) border-box
  `;

  // Hover spotlight — soft radial glow layered above the solid inner
  // surface, fades in on hover via group-hover:opacity-100.
  const spotlightBackground = useMotionTemplate`
    radial-gradient(${gradientSize}px circle at ${mouseX}px ${mouseY}px,
      ${gradientColor},
      transparent 100%
    )
  `;

  return (
    <motion.div
      className={cn(
        "group relative isolate overflow-hidden rounded-[inherit] border border-transparent",
        className,
      )}
      onPointerMove={handlePointerMove}
      onPointerLeave={reset}
      style={{ background: borderBackground }}
    >
      {/* Solid inner surface — covers everything except the 1px border. */}
      <div className="absolute inset-px z-20 rounded-[inherit] bg-bg-secondary" />

      {/* Hover spotlight layer. */}
      <motion.div
        suppressHydrationWarning
        className="pointer-events-none absolute inset-px z-30 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: spotlightBackground,
          opacity: gradientOpacity,
        }}
      />

      {/* Content — sits above both the surface and the spotlight. */}
      <div className="relative z-40">{children}</div>
    </motion.div>
  );
}
