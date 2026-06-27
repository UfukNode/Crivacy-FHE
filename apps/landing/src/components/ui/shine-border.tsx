"use client";

import { cn } from "@/lib/utils";

// Magic UI — ShineBorder
// https://magicui.design/docs/components/shine-border
// Animated radial gradient masked onto the container's border box.
// Positioned absolute, so the host must be `relative` with a matching
// border-radius (this element inherits it via rounded-[inherit]).

interface ShineBorderProps {
  borderWidth?: number;
  duration?: number;
  shineColor?: string | string[];
  className?: string;
  style?: React.CSSProperties;
}

export function ShineBorder({
  borderWidth = 1,
  duration = 14,
  shineColor = "#000000",
  className,
  style,
}: ShineBorderProps) {
  return (
    <div
      style={
        {
          "--border-width": `${borderWidth}px`,
          "--duration": `${duration}s`,
          backgroundImage: `radial-gradient(transparent,transparent, ${
            Array.isArray(shineColor) ? shineColor.join(",") : shineColor
          },transparent,transparent)`,
          backgroundSize: "300% 300%",
          mask: `linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0)`,
          WebkitMask: `linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0)`,
          WebkitMaskComposite: "xor",
          maskComposite: "exclude",
          padding: "var(--border-width)",
          ...style,
        } as React.CSSProperties
      }
      className={cn(
        "pointer-events-none absolute inset-0 size-full rounded-[inherit] will-change-[background-position] motion-safe:animate-shine",
        className,
      )}
    />
  );
}
