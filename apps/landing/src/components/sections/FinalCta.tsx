"use client";

import Aurora from "@/components/react-bits/Aurora";
import FadeContent from "@/components/react-bits/FadeContent";
import { SITE } from "@/lib/site";
import { useThemeColors } from "@/lib/use-theme-colors";

// FinalCta — the closing statement of the page. Intentionally stripped
// of CTA buttons and the "no credit card / setup in minutes" style note;
// both felt like generic SaaS copy that clashed with Crivacy's tone.
// What remains is a chapter-marker pill (matches WatchSection and
// Features), the big "Start verifying. Stop sharing." headline, and a
// single LOTR-inspired motto that carries the invitation without any
// product jargon.
export function FinalCta() {
  const { finalCta } = SITE;
  const colors = useThemeColors();
  const auroraStops: [string, string, string] = [
    colors.accentPrimary,
    colors.bgTertiary,
    colors.accentPrimary,
  ];

  return (
    <section
      id="final-cta"
      className="relative overflow-hidden border-t border-border-subtle bg-bg-primary"
    >
      {/* Aurora background — subtle, Crivacy accent tones */}
      <div className="pointer-events-none absolute inset-0 opacity-60">
        <Aurora
          colorStops={auroraStops}
          amplitude={0.9}
          blend={0.55}
          speed={0.6}
        />
      </div>

      {/* Bottom vignette — keeps edges dark without a gradient on the bg */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 40%, var(--bg-primary) 90%)",
        }}
      />

      <div
        className="relative mx-auto flex flex-col items-center gap-8 px-6 py-32 text-center"
        style={{ maxWidth: "var(--container-xl)" }}
      >
        {/* Chapter-marker pill — matches WatchSection ("Watch Our Intro")
            and Features ("Six guarantees baked into every credential")
            styling: px-4 py-1.5, text-[12px], tracking-[0.2em]. */}
        <FadeContent duration={800} threshold={0.2}>
          <div className="inline-flex items-center gap-2 rounded-full border border-accent-border bg-accent-muted px-4 py-1.5 font-mono text-[12px] tracking-[0.2em] text-accent-primary uppercase">
            {finalCta.badge}
          </div>
        </FadeContent>

        <FadeContent duration={900} delay={80} threshold={0.2}>
          <h2 className="max-w-2xl text-[44px] leading-[1.05] font-semibold tracking-tight text-text-primary sm:text-[56px] lg:text-[64px]">
            {finalCta.title}
          </h2>
        </FadeContent>

        {/* LOTR-flavoured motto — italic Satoshi so it reads as a
            quoted tagline rather than body copy. Sits in place of the
            old CTA buttons + note combo. */}
        <FadeContent duration={900} delay={160} threshold={0.2}>
          <p className="max-w-xl font-display text-[18px] leading-relaxed text-text-secondary italic sm:text-[20px]">
            {finalCta.motto}
          </p>
        </FadeContent>
      </div>
    </section>
  );
}
