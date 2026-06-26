"use client";

import BlurText from "@/components/react-bits/BlurText";
import DecryptedText from "@/components/react-bits/DecryptedText";
import Particles from "@/components/react-bits/Particles";
import { Button } from "@/components/ui/button";
import { CrivacyGlobe } from "@/components/ui/crivacy-globe";
import { PulsatingButton } from "@/components/ui/pulsating-button";
import { SITE } from "@/lib/site";
import { useThemeColors } from "@/lib/use-theme-colors";

export function Hero({
  onRequestAccess,
}: {
  onRequestAccess?: () => void;
}) {
  const colors = useThemeColors();

  return (
    <section
      id="top"
      className="relative overflow-hidden"
      style={{ minHeight: "calc(100dvh - var(--header-height))" }}
    >
      {/* Particles background — OGL WebGL, cosmic dance, mouse interactive */}
      <div className="absolute inset-0">
        <Particles
          particleCount={330}
          particleSpread={11}
          speed={0.1}
          particleBaseSize={100}
          particleColors={[colors.accentPrimary, colors.textPrimary, colors.textSecondary]}
          moveParticlesOnHover
          particleHoverFactor={1}
          alphaParticles
          sizeRandomness={1}
          cameraDistance={20}
        />
      </div>

      {/* Foreground content */}
      <div
        className="relative z-10 mx-auto grid min-h-[calc(100dvh-4rem)] content-center items-center gap-12 px-6 py-12 lg:grid-cols-5"
        style={{ maxWidth: "var(--container-xl)" }}
      >
        {/* Left — 3/5 */}
        <div className="flex flex-col gap-6 lg:col-span-3">
          {/* Badge */}
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-accent-border bg-accent-muted px-3 py-1 text-xs font-medium text-accent-primary">
            <span className="size-1.5 rounded-full bg-accent-primary" />
            {SITE.hero.badge}
          </div>

          {/* Title — only place font-weight 700 is allowed */}
          <h1 className="text-[56px] leading-[1.02] font-bold tracking-tight text-text-primary sm:text-[64px] lg:text-[72px]">
            <DecryptedText
              text={SITE.hero.title}
              animateOn="view"
              sequential
              revealDirection="start"
              speed={70}
              useOriginalCharsOnly
              parentClassName="block whitespace-nowrap"
              className="text-text-primary"
              encryptedClassName="text-accent-primary/55"
            />
            <DecryptedText
              text={SITE.hero.titleLine2}
              animateOn="view"
              sequential
              revealDirection="start"
              speed={70}
              useOriginalCharsOnly
              parentClassName="block whitespace-nowrap"
              className="text-text-primary"
              encryptedClassName="text-accent-primary/55"
            />
          </h1>

          {/* Subtitle via BlurText */}
          <div className="text-[20px] leading-[1.5] text-text-secondary sm:text-[22px]">
            <BlurText
              text={SITE.hero.subtitle}
              delay={70}
              stepDuration={0.42}
              className="[&]:font-sans"
            />
          </div>

          {/* CTAs */}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <PulsatingButton
              onClick={
                SITE.waitlistActive
                  ? onRequestAccess
                  : () => {
                      window.location.href = SITE.hero.ctaHref;
                    }
              }
              duration={SITE.waitlistActive ? "2.2s" : "0s"}
              className="h-11 px-5 text-sm font-medium"
            >
              {SITE.hero.cta}
            </PulsatingButton>
            <Button
              variant="outline"
              className="h-11 px-5 text-sm font-medium"
              onClick={() => {
                window.location.href = SITE.hero.ctaSecondaryHref;
              }}
            >
              {SITE.hero.ctaSecondary}
            </Button>
          </div>
        </div>

        {/* Right — 2/5, cobe v2 CrivacyGlobe (pulse-mode, auto-rotate, arcs) */}
        <div className="lg:col-span-2">
          <CrivacyGlobe />
        </div>
      </div>
    </section>
  );
}
