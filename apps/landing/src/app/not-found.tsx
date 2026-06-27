"use client";

// Crivacy 404 — "credential not found".
// Uses FuzzyText (canvas-displacement glitch effect from reactbits.dev)
// for the big "404" so the page feels like a broken signature rather
// than a generic error screen. Colors flow through useThemeColors so
// the canvas fill tracks whatever data-theme is active.

import Link from "next/link";
import { ArrowLeft, ShieldAlert } from "lucide-react";

import FuzzyText from "@/components/react-bits/FuzzyText";
import { useThemeColors } from "@/lib/use-theme-colors";

export default function NotFound() {
  const colors = useThemeColors();

  return (
    <main
      className="relative flex min-h-[100dvh] flex-col items-center justify-center gap-10 overflow-hidden bg-bg-primary px-6 py-24"
      style={{ minHeight: "calc(100dvh - var(--header-height))" }}
    >
      {/* Subtle scan line pattern — same treatment as PrivacyShield card,
          keeps the page quiet so FuzzyText is the focal point. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.035]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, var(--text-primary) 0 1px, transparent 1px 3px)",
        }}
      />

      {/* Small status badge */}
      <div className="relative inline-flex items-center gap-2 rounded-full border border-accent-border bg-accent-muted px-3 py-1 font-mono text-[10px] tracking-[0.18em] text-accent-primary uppercase">
        <ShieldAlert className="size-3.5" strokeWidth={2} />
        Credential Not Found
      </div>

      {/* FuzzyText 404 — canvas reads fontFamily from computed style, so
          wrapping in font-display (Satoshi) cascades the Crivacy face. */}
      <div className="relative font-display">
        <FuzzyText
          baseIntensity={0.18}
          hoverIntensity={0.42}
          enableHover
          fontWeight={900}
          fontSize="clamp(6rem, 22vw, 16rem)"
          color={colors.textPrimary}
          fuzzRange={26}
        >
          404
        </FuzzyText>
      </div>

      {/* Caption — Satoshi, Crivacy tone. Avoids generic "page not found"
          phrasing and ties the error back to the proof/credential motif. */}
      <div className="relative max-w-xl space-y-2 text-center">
        <p className="text-[clamp(1.05rem,1.6vw,1.35rem)] font-semibold text-text-primary">
          This route has no proof on chain.
        </p>
        <p className="text-[14px] leading-relaxed text-text-secondary">
          The page you&rsquo;re looking for either moved, never existed, or
          failed verification. Head back to the homepage to continue.
        </p>
      </div>

      {/* Back-to-home action — matches outline-button pattern used in Hero. */}
      <Link
        href="/"
        className="group relative inline-flex h-11 items-center gap-2 rounded-lg border border-border-default bg-bg-secondary/60 px-5 text-sm font-medium text-text-primary backdrop-blur-sm transition-colors hover:border-accent-border hover:bg-accent-muted hover:text-accent-primary"
      >
        <ArrowLeft className="size-4 transition-transform group-hover:-translate-x-0.5" />
        Return home
      </Link>
    </main>
  );
}
