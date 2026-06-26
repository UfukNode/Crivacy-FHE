"use client";

import {
  CircleCheck,
  EyeOff,
  KeyRound,
  Lock,
  RefreshCw,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

import FadeContent from "@/components/react-bits/FadeContent";
import PixelCard from "@/components/react-bits/PixelCard";
import { SITE } from "@/lib/site";
import { useThemeColors } from "@/lib/use-theme-colors";

const ICONS: Record<string, LucideIcon> = {
  Lock,
  RefreshCw,
  KeyRound,
  SlidersHorizontal,
  CircleCheck,
  EyeOff,
};

// Per-card decorative background illustrations. Cards without an entry
// render the plain PixelCard shimmer. Images live in /public and are
// dimmed + masked with a bottom gradient inside the card for legibility.
const CARD_BACKGROUNDS: Record<string, string> = {
  "Encrypted On-Chain": "/section-never.png",
  "Reusable Credential": "/section-reusable.png",
  "User-Owned": "/section-native.png",
  "You Control Access": "/section-integrate.png",
  "Firms Read Yes/No": "/section-grade.png",
  "No PII On-Chain": "/section-nopii.png",
};

export function Features() {
  const colors = useThemeColors();
  // Crivacy accent palette for the pixel shimmer canvas (brand accent + tint)
  const pixelColors = `${colors.accentPrimary},${colors.accentHover},${colors.bgTertiary}`;

  return (
    <section
      id="features"
      className="relative overflow-x-hidden border-t border-border-subtle bg-bg-primary py-24"
    >
      <div
        className="mx-auto px-6"
        style={{ maxWidth: "var(--container-xl)" }}
      >
        {/* Heading — matches the WatchSection pill badge so the two
            flagship sections share the same "chapter marker" pattern. */}
        <FadeContent duration={800} threshold={0.2}>
          <div className="mx-auto flex w-full max-w-4xl flex-col items-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-accent-border bg-accent-muted px-4 py-1.5 font-mono text-[12px] tracking-[0.2em] text-accent-primary uppercase">
              {SITE.features.subheading}
            </div>
          </div>
        </FadeContent>

        {/* 2x3 grid */}
        <div className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {SITE.features.items.map((feature, idx) => {
            const Icon = ICONS[feature.icon] ?? EyeOff;
            return (
              <FadeContent
                key={feature.title}
                duration={900}
                delay={idx * 90}
                threshold={0.15}
                className="min-w-0"
              >
                <PixelCard
                  gap={6}
                  speed={40}
                  colors={pixelColors}
                  className="!border-border-default hover:!border-accent-border"
                >
                  {/* Optional decorative background illustration (see
                      CARD_BACKGROUNDS map above). Sits above the PixelCard
                      canvas but below the content layer, dimmed heavily so
                      the light illustration reads as atmosphere on the
                      dark theme. A bottom gradient keeps the title and
                      description crisp. */}
                  {CARD_BACKGROUNDS[feature.title] && (
                    <>
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0"
                        style={{
                          backgroundImage: `url('${CARD_BACKGROUNDS[feature.title]}')`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                          backgroundRepeat: "no-repeat",
                          opacity: "var(--features-bg-opacity)",
                          filter: "var(--features-bg-filter)",
                          mixBlendMode:
                            "var(--features-bg-blend)" as React.CSSProperties["mixBlendMode"],
                        }}
                      />
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5"
                        style={{
                          backgroundImage:
                            "linear-gradient(to top, var(--bg-primary) 15%, color-mix(in srgb, var(--bg-primary) 55%, transparent) 55%, transparent 100%)",
                        }}
                      />
                    </>
                  )}

                  {/* Content layer sits above the pixel canvas */}
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-start justify-end p-6">
                    <div className="mb-4 flex size-11 items-center justify-center rounded-lg border border-accent-border bg-bg-secondary/80 text-accent-primary backdrop-blur-sm">
                      <Icon className="size-5" strokeWidth={1.75} />
                    </div>
                    <h3 className="text-[18px] leading-tight font-semibold text-text-primary">
                      {feature.title}
                    </h3>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary">
                      {feature.desc}
                    </p>
                  </div>
                </PixelCard>
              </FadeContent>
            );
          })}
        </div>
      </div>
    </section>
  );
}
