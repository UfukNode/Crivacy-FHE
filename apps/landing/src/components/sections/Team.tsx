"use client";

import type { ReactNode } from "react";

import { Mail } from "lucide-react";
import Image from "next/image";

import FadeContent from "@/components/react-bits/FadeContent";
import { MagicCard } from "@/components/ui/magic-card";
import { SITE } from "@/lib/site";
import { cn } from "@/lib/utils";

// MaskIcon — renders a monochrome SVG from /public as a CSS mask so the
// fill follows the current text color (via `bg-current`). lucide-react
// ships no brand marks, so GitHub / LinkedIn use the same cc-*.svg assets
// the floating ApplicationDock uses.
function MaskIcon({ src }: { src: string }) {
  return (
    <span
      aria-hidden="true"
      className="block size-4 bg-current"
      style={{
        maskImage: `url(${src})`,
        WebkitMaskImage: `url(${src})`,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
      }}
    />
  );
}

// SocialLink — token-driven pill icon button. Renders as an anchor when
// `href` is provided (opens in a new tab), or as a disabled button when
// the URL is empty. Empty URLs mark channels that are not yet available;
// the card layout stays symmetric while the affordance is clearly non-
// interactive (reduced opacity + cursor-not-allowed).
type SocialLinkProps = {
  label: string;
  href?: string;
  icon: ReactNode;
};

function SocialLink({ label, href, icon }: SocialLinkProps) {
  const base =
    "inline-flex size-9 items-center justify-center rounded-md border border-border-default bg-bg-tertiary/80 text-text-secondary transition-colors";

  if (!href) {
    return (
      <button
        type="button"
        aria-label={`${label} (unavailable)`}
        disabled
        className={cn(base, "cursor-not-allowed opacity-40")}
      >
        {icon}
      </button>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className={cn(
        base,
        "hover:border-accent-border hover:bg-accent-muted hover:text-accent-primary",
      )}
    >
      {icon}
    </a>
  );
}

export function Team() {
  const { team } = SITE;

  return (
    <section
      id="team"
      className="relative border-t border-border-subtle bg-bg-primary py-24"
    >
      <div
        className="mx-auto px-6"
        style={{ maxWidth: "var(--container-xl)" }}
      >
        {/* Heading */}
        <FadeContent duration={800} threshold={0.2}>
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-[40px] leading-[1.1] font-semibold tracking-tight text-text-primary sm:text-[48px]">
              {team.heading}
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-[15px] leading-relaxed text-text-secondary">
              {team.subheading}
            </p>
          </div>
        </FadeContent>

        {/* Grid — CEO left, CTO right on sm+. Each card is a MagicCard so
            the border lights up toward the cursor on hover. rounded-xl
            (12px, max per CLAUDE.md) propagates to MagicCard via
            `rounded-[inherit]` inside the component. */}
        <div className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-6 sm:grid-cols-3 lg:gap-10">
          {team.members.map((member, index) => (
            <FadeContent
              key={member.name}
              duration={900}
              delay={index * 120}
              threshold={0.15}
            >
              <MagicCard className="rounded-xl">
                <div className="flex flex-col items-center px-6 pt-8 pb-6 text-center">
                  {/* Centered square portrait with the site's rounded-xl
                      (12px) corners. Uses next/image fill + object-cover
                      inside a fixed-size wrapper so the source aspect is
                      cropped to a square without distortion. Not circular
                      per the spec. */}
                  <div className="relative size-[180px] overflow-hidden rounded-xl border border-border-subtle bg-bg-tertiary">
                    <Image
                      src={member.image}
                      alt={member.name}
                      fill
                      sizes="180px"
                      className="object-cover"
                      priority={index === 0}
                    />
                  </div>

                  {/* Name + role */}
                  <div className="mt-6">
                    <h3 className="text-[20px] leading-tight font-semibold text-text-primary">
                      {member.name}
                    </h3>
                    <p className="mt-1.5 font-mono text-[11px] tracking-[0.18em] text-accent-primary uppercase">
                      {member.role}
                    </p>
                  </div>

                  {/* Social row */}
                  <div className="mt-5 flex items-center justify-center gap-2">
                    <SocialLink
                      label={`${member.name} on GitHub`}
                      href={member.github || undefined}
                      icon={<MaskIcon src="/cc-github.svg" />}
                    />
                    <SocialLink
                      label={`${member.name} on LinkedIn`}
                      href={member.linkedin || undefined}
                      icon={<MaskIcon src="/cc-linkedin.svg" />}
                    />
                    <SocialLink
                      label={`Email ${member.name}`}
                      href={member.email || undefined}
                      icon={<Mail className="size-4" strokeWidth={1.75} />}
                    />
                    <SocialLink
                      label={`${member.name} on X`}
                      href={member.twitter || undefined}
                      icon={<MaskIcon src="/cc-x.svg" />}
                    />
                  </div>
                </div>
              </MagicCard>
            </FadeContent>
          ))}
        </div>
      </div>
    </section>
  );
}
