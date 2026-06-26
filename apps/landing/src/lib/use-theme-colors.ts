"use client";

import { useEffect, useState } from "react";

/**
 * Runtime-resolved design tokens for components that need hex strings
 * (WebGL uniforms, canvas strokes, prop APIs of third-party libs that
 * can't accept CSS custom properties).
 *
 * Source of truth is `src/styles/tokens.css`. This hook reads the
 * resolved values off `document.documentElement` and re-reads whenever
 * the `data-theme` attribute flips, so components stay in sync with
 * the active theme without any hardcoded hex strings.
 *
 * The `FALLBACK` object is the ONLY place in the codebase that knows
 * an explicit brand hex — it exists solely so SSR/first-paint has a
 * sane value before the browser can resolve the real CSS vars.
 */
export interface ThemeColors {
  accentPrimary: string;
  accentHover: string;
  accentPressed: string;
  accentContrast: string;
  accentBorder: string;
  rayTint: string;
  textPrimary: string;
  textSecondary: string;
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
}

const FALLBACK: ThemeColors = {
  accentPrimary: "#f3ff97",
  accentHover: "#fbffb4",
  accentPressed: "#e2ef78",
  accentContrast: "#0a0a0f",
  accentBorder: "rgba(243, 255, 151, 0.28)",
  rayTint: "#fcffea",
  textPrimary: "#e8e8ed",
  textSecondary: "#8a8a9a",
  bgPrimary: "#0a0a0f",
  bgSecondary: "#12121a",
  bgTertiary: "#1a1a28",
};

function readVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

export function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(FALLBACK);

  useEffect(() => {
    const read = () => {
      setColors({
        accentPrimary: readVar("--accent-primary") || FALLBACK.accentPrimary,
        accentHover: readVar("--accent-hover") || FALLBACK.accentHover,
        accentPressed: readVar("--accent-pressed") || FALLBACK.accentPressed,
        accentContrast: readVar("--accent-contrast") || FALLBACK.accentContrast,
        accentBorder: readVar("--accent-border") || FALLBACK.accentBorder,
        rayTint: readVar("--ray-tint") || FALLBACK.rayTint,
        textPrimary: readVar("--text-primary") || FALLBACK.textPrimary,
        textSecondary: readVar("--text-secondary") || FALLBACK.textSecondary,
        bgPrimary: readVar("--bg-primary") || FALLBACK.bgPrimary,
        bgSecondary: readVar("--bg-secondary") || FALLBACK.bgSecondary,
        bgTertiary: readVar("--bg-tertiary") || FALLBACK.bgTertiary,
      });
    };

    read();

    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  return colors;
}
