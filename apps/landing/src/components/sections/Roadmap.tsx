"use client";

import { useMemo } from "react";

import { Check, Circle } from "lucide-react";

import ElectricBorder from "@/components/react-bits/ElectricBorder";
import FadeContent from "@/components/react-bits/FadeContent";
import Hyperspeed from "@/components/react-bits/Hyperspeed";
import { Timeline } from "@/components/ui/timeline";
import { SITE } from "@/lib/site";
import { useThemeColors } from "@/lib/use-theme-colors";

// Roadmap milestone state. Derived from `done` + `active` flags in
// site.ts so the content file stays the single source of truth.
//   done    → shipped, accent badge with Check icon
//   active  → currently in progress, pulsing "Active" dot + ElectricBorder
//   planned → default, muted "Planned" badge with Circle icon
type Status = "done" | "active" | "planned";

// Hyperspeed expects numeric (0xRRGGBB) color values for three.js uniforms.
// Converts a `#rrggbb` string from useThemeColors into the right format.
// Returns 0 (black) on malformed input — safe default for fog/background.
function hexToInt(hex: string): number {
  if (!hex) return 0;
  const clean = hex.replace("#", "").trim();
  if (clean.length !== 6) return 0;
  return parseInt(clean, 16);
}

function StatusBadge({ status }: { status: Status }) {
  if (status === "done") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-accent-border bg-accent-muted px-2.5 py-1 font-mono text-[10px] tracking-wide text-accent-primary uppercase">
        <Check className="size-3" strokeWidth={2.5} />
        Shipped
      </span>
    );
  }

  if (status === "active") {
    // Vibrant variant of the "Shipped" / "Planned" badge. The background
    // is lifted from --accent-muted (12% accent) to ~28% via color-mix
    // so the Q2 2026 chip clearly pops against the card surface without
    // violating the no-glow rule. Stays theme-reactive because it still
    // resolves var(--accent-primary) at paint time.
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-accent-border px-2.5 py-1 font-mono text-[10px] tracking-wide text-accent-primary uppercase"
        style={{
          backgroundColor:
            "color-mix(in srgb, var(--accent-primary) 28%, transparent)",
        }}
      >
        {/* Radar-style pulse — outer ping expands+fades, inner dot stays
            solid. Uses Tailwind's built-in animate-ping which is just a
            scale+opacity keyframe, so no glow/neon rule violation. */}
        <span className="relative flex size-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-primary opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-accent-primary" />
        </span>
        Active
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border-default bg-bg-tertiary px-2.5 py-1 font-mono text-[10px] tracking-wide text-text-tertiary uppercase">
      <Circle className="size-3" strokeWidth={2} />
      Planned
    </span>
  );
}

export function Roadmap() {
  const { roadmap } = SITE;
  // Runtime-resolved accent so ElectricBorder + Hyperspeed both follow
  // theme flips. Canvas/WebGL can't read CSS vars — see use-theme-colors.ts.
  const colors = useThemeColors();

  // Hyperspeed preset "five" (turbulentDistortion) adapted to Crivacy
  // tokens. Memoized on hex values so we only rebuild the WebGL scene
  // when the theme actually flips, not on every React render.
  //
  // Color rationale:
  //   - roadColor / islandColor → match site surfaces so the road blends
  //     into the page background
  //   - background → bgPrimary (used by three.js Fog for atmospheric tint)
  //   - leftCars → brand accent family (primary + hover + pressed) gives
  //     a warm stream on the left lanes
  //   - rightCars → text tones + accent for neutral contrast streaks
  //   - sticks → accent so roadside posts sync with the brand
  //   - shoulder / brokenLines → subtle surface tone, barely visible
  const effectOptions = useMemo(
    () => ({
      distortion: "turbulentDistortion",
      length: 400,
      roadWidth: 9,
      islandWidth: 2,
      lanesPerRoad: 3,
      fov: 90,
      fovSpeedUp: 150,
      speedUp: 2,
      carLightsFade: 0.4,
      totalSideLightSticks: 50,
      lightPairsPerRoadWay: 50,
      shoulderLinesWidthPercentage: 0.05,
      brokenLinesWidthPercentage: 0.1,
      brokenLinesLengthPercentage: 0.5,
      lightStickWidth: [0.12, 0.5] as [number, number],
      lightStickHeight: [1.3, 1.7] as [number, number],
      movingAwaySpeed: [60, 80] as [number, number],
      movingCloserSpeed: [-120, -160] as [number, number],
      carLightsLength: [400 * 0.05, 400 * 0.15] as [number, number],
      carLightsRadius: [0.05, 0.14] as [number, number],
      carWidthPercentage: [0.3, 0.5] as [number, number],
      carShiftX: [-0.2, 0.2] as [number, number],
      carFloorSeparation: [0.05, 1] as [number, number],
      colors: {
        roadColor: hexToInt(colors.bgPrimary),
        islandColor: hexToInt(colors.bgSecondary),
        background: hexToInt(colors.bgPrimary),
        shoulderLines: hexToInt(colors.bgTertiary),
        brokenLines: hexToInt(colors.bgTertiary),
        leftCars: [
          hexToInt(colors.accentPrimary),
          hexToInt(colors.accentHover),
          hexToInt(colors.accentPressed),
        ],
        rightCars: [
          hexToInt(colors.textPrimary),
          hexToInt(colors.textSecondary),
          hexToInt(colors.accentPrimary),
        ],
        sticks: hexToInt(colors.accentPrimary),
      },
    }),
    [
      colors.bgPrimary,
      colors.bgSecondary,
      colors.bgTertiary,
      colors.accentPrimary,
      colors.accentHover,
      colors.accentPressed,
      colors.textPrimary,
      colors.textSecondary,
    ],
  );

  const timelineData = roadmap.items.map((item) => {
    const status: Status = item.done
      ? "done"
      : item.active
        ? "active"
        : "planned";

    const card = (
      <div className="rounded-xl border border-border-subtle bg-bg-secondary/70 p-6 backdrop-blur-sm">
        <div className="flex items-start justify-between gap-4">
          <h4 className="text-[20px] leading-tight font-semibold text-text-primary sm:text-[22px]">
            {item.title}
          </h4>
          <StatusBadge status={status} />
        </div>
        <p className="mt-3 text-[14px] leading-relaxed text-text-secondary">
          {item.desc}
        </p>
      </div>
    );

    // Horizontal bridge rendered by Timeline inside its sticky column.
    // A single 1px line from the rail dot to the card's left edge. The
    // active milestone gets the accent color, planned/done items use
    // the subtle border token so the active one pops. Timeline renders
    // this at zIndex: -1 so the Q label text overlays it cleanly with
    // no strikethrough.
    const connector = (
      <div
        className="h-px w-full"
        style={{
          backgroundColor:
            status === "active"
              ? "var(--accent-primary)"
              : "var(--border-default)",
        }}
      />
    );

    // Active milestone also gets a custom timeline dot: the default
    // (border-accent-border + bg-accent-muted) is replaced with an
    // ElectricBorder-wrapped 40px circle whose inner fill is the full
    // accent-primary (no muting / no border ring) so the in-progress
    // milestone pops off the rail. Non-active items fall back to the
    // default dot by leaving this field undefined.
    const activeDot =
      status === "active" ? (
        <ElectricBorder
          color={colors.accentPrimary}
          speed={1.4}
          chaos={0.015}
          borderRadius={999}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-accent-border bg-bg-secondary">
            <div className="h-3 w-3 rounded-full bg-accent-primary" />
          </div>
        </ElectricBorder>
      ) : undefined;

    return {
      title: item.quarter,
      dot: activeDot,
      connector,
      // Only the active milestone gets wrapped in ElectricBorder — the
      // others render as plain cards so the in-progress one is the
      // unambiguous visual anchor of the timeline.
      content:
        status === "active" ? (
          <ElectricBorder
            color={colors.accentPrimary}
            speed={1}
            chaos={0.015}
            borderRadius={12}
          >
            {card}
          </ElectricBorder>
        ) : (
          card
        ),
    };
  });

  return (
    <section
      id="roadmap"
      className="relative overflow-hidden border-t border-border-subtle bg-bg-primary py-24"
    >
      {/* Hyperspeed background — fills the whole section behind the
          timeline. pointer-events-none so the road doesn't steal the
          mouse/touch events meant for the milestone cards (the Hyperspeed
          container otherwise binds mousedown/touchstart for speed-up).
          A soft radial vignette fades the edges into the page bg so the
          road doesn't look like a hard-cropped rectangle. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0"
      >
        <Hyperspeed effectOptions={effectOptions} />
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 0%, transparent 45%, var(--bg-primary) 100%)",
          }}
        />
      </div>

      <div
        className="relative z-10 mx-auto px-6"
        style={{ maxWidth: "var(--container-xl)" }}
      >
        {/* "ROADMAP" pill badge — mirrors the Features section chapter
            marker so the two flagship sections share the same pattern. */}
        <FadeContent duration={800} threshold={0.2}>
          <div className="mx-auto flex w-full max-w-4xl flex-col items-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-accent-border bg-accent-muted px-4 py-1.5 font-mono text-[12px] tracking-[0.2em] text-accent-primary uppercase">
              Roadmap
            </div>
          </div>
        </FadeContent>

        <FadeContent duration={800} delay={120} threshold={0.2}>
          <Timeline data={timelineData} />
        </FadeContent>
      </div>
    </section>
  );
}
