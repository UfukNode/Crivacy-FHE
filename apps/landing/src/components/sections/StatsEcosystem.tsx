"use client";

import { useState } from "react";
import {
  Building2,
  Code,
  Fingerprint,
  Network,
  ShieldCheck,
  Webhook,
  type LucideIcon,
} from "lucide-react";

import FadeContent from "@/components/react-bits/FadeContent";
import GlareHover from "@/components/react-bits/GlareHover";
import { CrivacyLogoMark } from "@/components/ui/crivacy-logo-mark";
import { NumberTicker } from "@/components/ui/number-ticker";
import { OrbitingCircles } from "@/components/ui/orbiting-circles";
import { SITE } from "@/lib/site";
import { useThemeColors } from "@/lib/use-theme-colors";

// Map stack labels to a Lucide icon. Every layer resolves to an icon;
// anything unmapped falls back to Building2 in the render.
const ECOSYSTEM_ICONS: Record<string, LucideIcon | null> = {
  "Zama FHE": ShieldCheck,
  Sepolia: Network,
  Didit: Fingerprint,
  Relayer: Code,
  Wallets: Building2,
  Webhooks: Webhook,
};

const ECOSYSTEM_SVGS: Record<string, string> = {};

export function StatsEcosystem() {
  const { stats } = SITE;
  const { ecosystem } = stats;
  // Theme-reactive accent for GlareHover. useThemeColors re-reads CSS
  // custom props on data-theme flips so the glare follows dark/light.
  const colors = useThemeColors();

  return (
    <section
      id="stats"
      className="relative border-t border-border-subtle bg-bg-primary py-24"
    >
      <div
        className="mx-auto px-6"
        style={{ maxWidth: "var(--container-xl)" }}
      >
        {/* Heading */}
        <FadeContent duration={800} threshold={0.2}>
          <div className="mx-auto max-w-xl text-center">
            <h2 className="text-[40px] leading-[1.1] font-semibold tracking-tight text-text-primary sm:text-[48px]">
              {stats.heading}
            </h2>
          </div>
        </FadeContent>

        {/* Stats (2/3) + Ecosystem (1/3) */}
        <div className="mt-16 grid gap-10 lg:grid-cols-3 lg:gap-12">
          {/* LEFT — 4 stats in 2x2 grid. Each card is wrapped in a
              GlareHover — the react-bits component that sweeps a
              gradient across the surface on mouseover. The wrapper is
              configured with `!block` + `!h-full` to strip out the
              library's default `grid place-items-center` centering
              (which would squash our flex-column content) and to make
              the card stretch to the row height like before. Glare
              color is theme-reactive via useThemeColors. */}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:col-span-2">
            {stats.items.map((item, idx) => (
              <FadeContent
                key={item.label}
                duration={900}
                delay={idx * 90}
                threshold={0.15}
                className="h-full"
              >
                <GlareHover
                  width="100%"
                  height="100%"
                  background="color-mix(in srgb, var(--bg-secondary) 60%, transparent)"
                  borderRadius="12px"
                  borderColor="var(--border-subtle)"
                  glareColor={colors.accentPrimary}
                  glareOpacity={0.45}
                  glareAngle={-30}
                  glareSize={280}
                  transitionDuration={800}
                  className="!block !h-full !cursor-default"
                >
                  <div className="relative flex h-full w-full flex-col justify-between gap-6 p-6">
                    <span className="font-mono text-[10px] tracking-[0.18em] text-text-tertiary uppercase">
                      {item.label}
                    </span>
                    <div className="flex items-baseline gap-1">
                      <NumberTicker
                        value={item.value}
                        decimalPlaces={0}
                        className="!text-text-primary text-[44px] leading-none font-semibold tracking-tight tabular-nums sm:text-[52px]"
                      />
                      {item.suffix && (
                        <span className="text-[20px] font-semibold text-text-secondary">
                          {item.suffix}
                        </span>
                      )}
                    </div>
                  </div>
                </GlareHover>
              </FadeContent>
            ))}
          </div>

          {/* RIGHT — Ecosystem orbit diagram */}
          <FadeContent
            duration={900}
            delay={120}
            threshold={0.15}
            className="lg:col-span-1"
          >
            <div className="flex h-full flex-col gap-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] tracking-[0.18em] text-text-tertiary uppercase">
                  {ecosystem.heading}
                </span>
                <span className="font-mono text-[10px] text-text-tertiary">
                  {ecosystem.orbit.length} layers
                </span>
              </div>

              <div className="relative flex h-[360px] w-full items-center justify-center overflow-hidden rounded-xl border border-border-subtle bg-bg-secondary/40">
                {/* Center — Crivacy logo mark with hover zoom */}
                <div className="group/center relative z-10 flex size-16 cursor-pointer items-center justify-center rounded-full border border-accent-border bg-bg-secondary text-accent-primary transition-all duration-300 ease-out hover:scale-110 hover:border-accent-primary">
                  <CrivacyLogoMark className="size-7 transition-transform duration-300 group-hover/center:scale-110" />
                </div>

                {/* Orbit — hoverable items with tooltip */}
                <OrbitingCircles radius={130} duration={28} iconSize={42}>
                  {ecosystem.orbit.map((label) => {
                    const Icon = ECOSYSTEM_ICONS[label];
                    const svg = ECOSYSTEM_SVGS[label];
                    return (
                      <div
                        key={label}
                        className="group/orbit relative flex size-full cursor-pointer items-center justify-center rounded-lg border border-border-default bg-bg-tertiary text-text-secondary transition-all duration-200 ease-out hover:scale-110 hover:border-accent-primary hover:bg-bg-secondary hover:text-accent-primary"
                      >
                        {svg ? (
                          <div
                            className="size-5"
                            style={{
                              maskImage: `url(${svg})`,
                              WebkitMaskImage: `url(${svg})`,
                              maskSize: "contain",
                              WebkitMaskSize: "contain",
                              maskRepeat: "no-repeat",
                              WebkitMaskRepeat: "no-repeat",
                              maskPosition: "center",
                              WebkitMaskPosition: "center",
                              backgroundColor: "currentColor",
                            }}
                          />
                        ) : Icon ? (
                          <Icon className="size-5" strokeWidth={1.75} />
                        ) : (
                          <Building2 className="size-5" strokeWidth={1.75} />
                        )}
                        {/* Tooltip */}
                        <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 rounded-md border border-border-default bg-bg-secondary px-2 py-1 font-mono text-[9px] tracking-[0.1em] text-text-primary whitespace-nowrap opacity-0 transition-opacity duration-200 group-hover/orbit:opacity-100">
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </OrbitingCircles>

              </div>
            </div>
          </FadeContent>
        </div>
      </div>
    </section>
  );
}
