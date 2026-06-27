"use client";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

interface DotFieldProps {
  className?: string;
  dotSize?: number;
  spacing?: number;
  spotlightRadius?: number;
}

export function DotField({
  className,
  dotSize = 1.3,
  spacing = 26,
  spotlightRadius = 220,
}: DotFieldProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    if (window.matchMedia("(hover: none)").matches) {
      el.style.setProperty("--mx", "50%");
      el.style.setProperty("--my", "30%");
      el.style.setProperty("--spot", "0");
      return;
    }

    el.style.setProperty("--spot", "1");

    let raf = 0;
    let pendingX = 0;
    let pendingY = 0;

    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      pendingX = e.clientX - rect.left;
      pendingY = e.clientY - rect.top;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        el.style.setProperty("--mx", `${pendingX}px`);
        el.style.setProperty("--my", `${pendingY}px`);
        raf = 0;
      });
    };

    const onLeave = () => {
      el.style.setProperty("--spot", "0");
    };
    const onEnter = () => {
      el.style.setProperty("--spot", "1");
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointerleave", onLeave);

    return () => {
      window.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("pointerleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        className,
      )}
      style={
        {
          "--dot": `${dotSize}px`,
          "--gap": `${spacing}px`,
          "--r": `${spotlightRadius}px`,
          "--mx": "50%",
          "--my": "30%",
          "--spot": "0",
        } as React.CSSProperties
      }
    >
      {/* Base dot layer — always visible, low-contrast */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle, var(--text-tertiary) var(--dot), transparent calc(var(--dot) + 0.6px))",
          backgroundSize: "var(--gap) var(--gap)",
          backgroundPosition: "0 0",
          opacity: 0.45,
        }}
      />
      {/* Brighter dot layer revealed under the cursor via radial mask */}
      <div
        className="absolute inset-0 transition-opacity duration-300"
        style={{
          backgroundImage:
            "radial-gradient(circle, var(--accent-primary) calc(var(--dot) + 0.4px), transparent calc(var(--dot) + 1.2px))",
          backgroundSize: "var(--gap) var(--gap)",
          backgroundPosition: "0 0",
          opacity: "calc(0.55 * var(--spot))",
          WebkitMaskImage:
            "radial-gradient(circle var(--r) at var(--mx) var(--my), black 0%, transparent 75%)",
          maskImage:
            "radial-gradient(circle var(--r) at var(--mx) var(--my), black 0%, transparent 75%)",
        }}
      />
      {/* Vignette — fades dots into background at edges so the field
          reads as atmosphere, not chrome */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 90% 70% at 50% 40%, transparent 0%, var(--bg-primary) 92%)",
        }}
      />
    </div>
  );
}
