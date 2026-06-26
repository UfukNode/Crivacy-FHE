"use client";

import Image from "next/image";

import { Check, Fingerprint, Lock, ShieldCheck } from "lucide-react";

import TrueFocus from "@/components/react-bits/TrueFocus";
import { ShineBorder } from "@/components/ui/shine-border";
import { SITE } from "@/lib/site";
import { useThemeColors } from "@/lib/use-theme-colors";

export function PrivacyShield() {
  const { privacyShield } = SITE;
  const { credential } = privacyShield;
  const colors = useThemeColors();

  return (
    <section
      id="privacy-shield"
      className="relative border-t border-border-subtle bg-bg-primary py-24"
    >
      <div
        className="mx-auto grid gap-12 px-6 lg:grid-cols-3 lg:gap-16"
        style={{ maxWidth: "var(--container-xl)" }}
      >
        {/* LEFT — TrueFocus heading + ScrollReveal narration (col-span-2) */}
        <div className="flex flex-col gap-10 lg:col-span-2">
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-accent-border bg-accent-muted px-3 py-1 font-mono text-[10px] tracking-[0.18em] text-accent-primary uppercase">
            Privacy Shield
          </div>

          {/* TrueFocus animated heading */}
          <div className="-ml-2">
            <TrueFocus
              sentence={privacyShield.heading}
              borderColor={colors.accentPrimary}
              glowColor="transparent"
              animationDuration={0.45}
              pauseBetweenAnimations={1.1}
              blurAmount={4}
            />
          </div>

          {/* Narration — plain static paragraph. ScrambledText was removed
              because variable-width glyph swaps caused the line count to
              jump mid-animation (3 lines → 2 lines), which shifted the
              section layout. Static text keeps things stable. */}
          <p className="max-w-2xl font-display text-[clamp(1.2rem,2.2vw,1.75rem)] font-semibold leading-[1.45] text-text-primary">
            {`${privacyShield.reveals[0]} anchors the proof. ${privacyShield.reveals[1]} carries no personal data. ${privacyShield.reveals[2]} - you stay in control.`}
          </p>

          {/* Trust line */}
          <div className="flex flex-wrap items-center gap-6 border-t border-border-subtle pt-6 text-[12px] text-text-tertiary">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-accent-primary" />
              Zero-knowledge proof
            </div>
            <div className="flex items-center gap-2">
              <Fingerprint className="size-4 text-accent-primary" />
              Self-custodial identity
            </div>
            <div className="flex items-center gap-2">
              <Check className="size-4 text-accent-primary" />
              Verifiable on-chain
            </div>
          </div>
        </div>

        {/* RIGHT — 3D flip credential card (hover to reveal security manifest) */}
        <div className="flex items-center justify-center lg:col-span-1">
          <div className="group relative mx-auto h-[360px] w-full max-w-[320px] [perspective:1000px]">
            {/* Flipping wrapper — transform-style:preserve-3d keeps front/back
               children in the same 3D context so rotateY shows each face. */}
            <div className="relative h-full w-full transition-transform duration-700 ease-out [transform-style:preserve-3d] group-hover:[transform:rotateY(180deg)]">
              {/* FRONT — current credential card */}
              <article className="absolute inset-0 overflow-hidden rounded-xl bg-bg-secondary p-6 shadow-[var(--shadow-md)] [backface-visibility:hidden]">
                <ShineBorder
                  borderWidth={1}
                  duration={12}
                  shineColor={[
                    colors.accentPrimary,
                    colors.accentHover,
                    colors.accentPrimary,
                  ]}
                />
                {/* Subtle scan line pattern */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 opacity-[0.04]"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(0deg, var(--text-primary) 0 1px, transparent 1px 3px)",
                  }}
                />

                <div className="relative flex items-center justify-between">
                  <span className="font-mono text-[10px] tracking-[0.18em] text-text-tertiary uppercase">
                    {credential.label}
                  </span>
                  <span className="flex size-8 items-center justify-center rounded-lg border border-accent-border bg-accent-muted text-accent-primary">
                    <ShieldCheck className="size-4" strokeWidth={1.75} />
                  </span>
                </div>

                <div className="relative mt-6 space-y-1">
                  <div className="font-mono text-[11px] text-text-tertiary">
                    Holder
                  </div>
                  <div className="font-mono text-[15px] tracking-wide text-text-primary">
                    {credential.holder}
                  </div>
                </div>

                <div className="relative mt-4 grid grid-cols-2 gap-4">
                  <div>
                    <div className="font-mono text-[10px] text-text-tertiary">
                      Status
                    </div>
                    <div className="mt-1 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent-primary">
                      <span className="size-1.5 rounded-full bg-accent-primary" />
                      {credential.status}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[10px] text-text-tertiary">
                      Issued
                    </div>
                    <div className="mt-1 font-mono text-[12px] text-text-secondary">
                      {credential.issued}
                    </div>
                  </div>
                </div>

                <div className="relative mt-6 border-t border-border-subtle pt-4">
                  <div className="font-mono text-[10px] text-text-tertiary">
                    {credential.validator}
                  </div>
                </div>

                {/* Hover affordance — tiny hint that the card flips */}
                <div className="pointer-events-none absolute right-4 bottom-4 font-mono text-[9px] tracking-[0.14em] text-text-tertiary uppercase opacity-60">
                  Hover →
                </div>
              </article>

              {/* BACK — security manifest */}
              <article className="absolute inset-0 flex flex-col overflow-hidden rounded-xl bg-bg-tertiary p-6 shadow-[var(--shadow-md)] [backface-visibility:hidden] [transform:rotateY(180deg)]">
                <ShineBorder
                  borderWidth={1}
                  duration={12}
                  shineColor={[
                    colors.accentPrimary,
                    colors.accentHover,
                    colors.accentPrimary,
                  ]}
                />
                {/* Header */}
                <div className="relative flex items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-lg border border-accent-border bg-accent-muted text-accent-primary">
                    <Lock className="size-4" strokeWidth={1.75} />
                  </span>
                  <span className="font-mono text-[11px] tracking-[0.14em] text-accent-primary uppercase">
                    Secured by FHE
                  </span>
                </div>

                {/* Security bullets */}
                <ul className="relative mt-5 space-y-2">
                  {[
                    "Zero-knowledge proof",
                    "No personal data stored",
                    "Self-custodial identity",
                    "Auditable on-chain",
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-2.5">
                      <Check
                        className="mt-0.5 size-4 shrink-0 text-accent-primary"
                        strokeWidth={2.25}
                      />
                      <span className="text-[12.5px] leading-relaxed text-text-secondary">
                        {item}
                      </span>
                    </li>
                  ))}
                </ul>

                {/* brand-sealed ring + quote footer — pushed to bottom.
                   The ring PNG uses a layered drop-shadow filter (which follows
                   the image's alpha channel) to produce a subtle brand aura
                   around the seal without resorting to forbidden box-glow. */}
                <div className="relative mt-auto flex flex-col items-center gap-2 border-t border-border-subtle pt-3">
                  <Image
                    src="/crivacyring.png"
                    width={88}
                    height={88}
                    alt="Crivacy credential sealed by FHE"
                    className="h-[88px] w-[88px] object-contain"
                    style={{
                      filter:
                        "drop-shadow(0 0 6px var(--accent-muted)) drop-shadow(0 0 16px color-mix(in srgb, var(--accent-primary) 22%, transparent))",
                    }}
                    priority={false}
                  />
                  <p className="text-center font-mono text-[10px] leading-relaxed text-text-tertiary italic">
                    &ldquo;One KYC to rule them all.&rdquo;
                  </p>
                </div>
              </article>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
