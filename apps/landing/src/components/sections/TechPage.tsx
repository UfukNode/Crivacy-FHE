"use client";

import {
  ArrowUpRight,
  Box,
  FileCode2,
  GitBranch,
  GitPullRequest,
  Network,
  Plug,
  ScrollText,
  ShieldCheck,
  Workflow,
} from "lucide-react";

import DecryptedText from "@/components/react-bits/DecryptedText";
import FadeContent from "@/components/react-bits/FadeContent";
import { ApplicationDock } from "@/components/sections/ApplicationDock";
import { Footer } from "@/components/sections/Footer";
import { Navbar } from "@/components/sections/Navbar";
import { DotField } from "@/components/ui/dot-field";
import { SITE } from "@/lib/site";
import { cn } from "@/lib/utils";

const STACK_ICONS = [Network, FileCode2, Plug, Box];

export function TechPage() {
  const { tech } = SITE;

  return (
    <div className="relative flex w-full flex-1 flex-col">
      <Navbar />

      <main className="relative flex flex-1 flex-col bg-bg-primary">
        {/* ------------------------------------------------------------- HERO */}
        <section className="relative overflow-hidden border-b border-border-subtle">
          <DotField />

          <div
            className="relative z-10 mx-auto flex flex-col items-start gap-8 px-6 pt-24 pb-20 sm:pt-32 sm:pb-28"
            style={{ maxWidth: "var(--container-xl)" }}
          >
            {/* Badge */}
            <div className="inline-flex items-center gap-2 rounded-full border border-accent-border bg-accent-muted px-3 py-1 font-mono text-[11px] tracking-[0.18em] text-accent-primary uppercase">
              <span className="size-1.5 rounded-full bg-accent-primary" />
              {tech.badge}
            </div>

            {/* Title — single place font-weight 700 lives on this page.
                DecryptedText renders inline spans so it nests cleanly
                inside the h1 (BlurText emits a <p> which would be
                invalid markup here). */}
            <h1 className="max-w-3xl text-[44px] leading-[1.04] font-bold tracking-tight text-text-primary sm:text-[56px] lg:text-[64px]">
              <DecryptedText
                text={tech.title}
                animateOn="view"
                sequential
                revealDirection="start"
                speed={55}
                useOriginalCharsOnly
                parentClassName="block"
                className="text-text-primary"
                encryptedClassName="text-accent-primary/55"
              />
            </h1>

            {/* Intro paragraph */}
            <p className="max-w-2xl text-[15px] leading-relaxed text-text-secondary sm:text-base">
              Crivacy runs on{" "}
              <a
                href={tech.cta.repo.href}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-text-primary underline decoration-border-default underline-offset-4 transition-colors hover:text-accent-primary hover:decoration-accent-primary"
              >
                @crivacy-fhe
              </a>
              , an open-source SDK for issuing and verifying confidential KYC
              credentials with FHE on Sepolia.
            </p>

            {/* CTAs — both share the same dark pill geometry so they read
                as a balanced pair (not "big yellow + wimpy gray"). The
                primary picks up an accent border + accent text on hover. */}
            <div className="mt-2 flex flex-col gap-3 sm:flex-row">
              <PillLink
                href={tech.cta.repo.href}
                icon={GitBranch}
                primary
              >
                {tech.cta.repo.label}
              </PillLink>
              <PillLink href={tech.cta.cip.href} icon={ScrollText}>
                {tech.cta.cip.label}
              </PillLink>
            </div>

            {/* Hero stat strip — license + network + status only. No
                timeline claims; tech reviewers can read commit history
                on the @crivacy-fhe repo for tenure. */}
            <div className="mt-10 flex flex-col gap-6 border-t border-border-subtle pt-8 sm:flex-row sm:gap-12">
              <HeroStat
                label="License"
                value="MIT"
              />
              <HeroStat
                label="Network"
                value="Sepolia"
              />
              <HeroStat
                label="Status"
                value="Live on testnet"
                accent
              />
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ STACK */}
        <section className="relative border-b border-border-subtle bg-bg-primary py-24">
          <div
            className="mx-auto px-6"
            style={{ maxWidth: "var(--container-xl)" }}
          >
            <SectionHeading
              eyebrow="01 · Stack"
              title={tech.stack.heading}
              subtitle={tech.stack.subheading}
            />

            <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border-subtle bg-border-subtle md:grid-cols-2">
              {tech.stack.items.map((item, idx) => {
                const Icon = STACK_ICONS[idx] ?? Box;
                return (
                  <FadeContent
                    key={item.name}
                    duration={500}
                    delay={idx * 60}
                    threshold={0.1}
                  >
                    <div className="flex h-full flex-col gap-4 bg-bg-secondary p-6 sm:p-8">
                      <div className="flex items-center gap-3">
                        <div className="flex size-9 items-center justify-center rounded-md border border-border-default bg-bg-tertiary">
                          <Icon className="size-4 text-accent-primary" />
                        </div>
                        <div className="flex flex-1 items-center justify-between gap-3">
                          {"href" in item && item.href ? (
                            <a
                              href={item.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="group inline-flex items-center gap-1.5 font-display text-[17px] font-semibold text-text-primary transition-colors hover:text-accent-primary"
                            >
                              {item.name}
                              <ArrowUpRight className="size-3.5 opacity-50 transition-opacity group-hover:opacity-100" />
                            </a>
                          ) : (
                            <span className="font-display text-[17px] font-semibold text-text-primary">
                              {item.name}
                            </span>
                          )}
                          {"tag" in item && item.tag && (
                            <span className="rounded-md border border-accent-border bg-accent-muted px-2 py-0.5 font-mono text-[10px] tracking-[0.1em] text-accent-primary uppercase">
                              {item.tag}
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="text-[14px] leading-relaxed text-text-secondary">
                        {item.role}
                      </p>
                      {"links" in item && item.links && (
                        <div className="mt-1 flex flex-wrap gap-2">
                          {item.links.map((l) => (
                            <a
                              key={l.label}
                              href={l.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 rounded-md border border-border-default bg-bg-tertiary px-2.5 py-1 font-mono text-[11px] text-text-secondary transition-colors hover:border-accent-border hover:text-accent-primary"
                            >
                              {l.label}
                              <ArrowUpRight className="size-3 opacity-60" />
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </FadeContent>
                );
              })}
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------- WHY OPEN */}
        <section className="relative border-b border-border-subtle bg-bg-primary py-24">
          <div
            className="mx-auto grid gap-12 px-6 lg:grid-cols-[1fr_2fr]"
            style={{ maxWidth: "var(--container-xl)" }}
          >
            <SectionHeading
              eyebrow="02 · Why"
              title={tech.why.heading}
              align="left"
              compact
            />
            <div className="flex flex-col gap-5 text-[15px] leading-relaxed text-text-secondary">
              {tech.why.paragraphs.map((p, i) => (
                <FadeContent key={i} duration={500} delay={i * 80} threshold={0.2}>
                  <p>{p}</p>
                </FadeContent>
              ))}
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------- ON-CHAIN VERIFY */}
        <section className="relative border-b border-border-subtle bg-bg-primary py-24">
          <div
            className="mx-auto px-6"
            style={{ maxWidth: "var(--container-xl)" }}
          >
            <SectionHeading
              eyebrow="03 · Verify"
              title={tech.verify.heading}
            />

            <p className="mx-auto mt-6 max-w-3xl text-center text-[15px] leading-relaxed text-text-secondary">
              {tech.verify.body}
            </p>

            {/* Fact list — two monospaced cards with the on-chain
                anchors a reviewer can paste straight into an Etherscan
                or RPC query. */}
            <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border-subtle bg-border-subtle md:grid-cols-2">
              <FactCard
                icon={ShieldCheck}
                label="CrivacyKYC contract"
                value={tech.contractAddress}
                mono
              />
              <FactCard
                icon={Workflow}
                label="Network"
                value={tech.network}
                mono
              />
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------- STANDARDS */}
        <section className="relative border-b border-border-subtle bg-bg-primary py-24">
          <div
            className="mx-auto grid gap-10 px-6 lg:grid-cols-[2fr_1fr]"
            style={{ maxWidth: "var(--container-xl)" }}
          >
            <div className="flex flex-col gap-6">
              <SectionHeading
                eyebrow="04 · Standards"
                title={tech.standards.heading}
                align="left"
                compact
              />
              <p className="max-w-2xl text-[15px] leading-relaxed text-text-secondary">
                {tech.standards.body}
              </p>
              <div className="mt-2 w-fit">
                <PillLink
                  href={tech.cta.cip.href}
                  icon={ScrollText}
                  primary
                >
                  Read the docs
                </PillLink>
              </div>
            </div>

            {/* Decorative "scroll" — animated decrypt of the doc path
                so reviewers see exactly what they'll be reading. */}
            <div className="relative flex items-center justify-center">
              <div className="w-full rounded-xl border border-border-default bg-bg-secondary p-6 font-mono text-[12px] leading-relaxed text-text-secondary">
                <div className="mb-3 flex items-center gap-2 text-text-tertiary">
                  <span className="size-2 rounded-full bg-state-success" />
                  <span className="text-[10px] tracking-[0.2em] uppercase">
                    crivacy-fhe / docs
                  </span>
                </div>
                <DecryptedText
                  text="crivacy-fhe-credential-sdk.md"
                  animateOn="view"
                  sequential
                  revealDirection="start"
                  speed={45}
                  useOriginalCharsOnly
                  className="text-text-primary"
                  encryptedClassName="text-accent-primary/55"
                />
              </div>
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------- CONTRIBUTE */}
        <section className="relative border-b border-border-subtle bg-bg-primary py-24">
          <div
            className="mx-auto flex flex-col items-center gap-6 px-6 text-center"
            style={{ maxWidth: "var(--container-lg)" }}
          >
            <SectionHeading
              eyebrow="05 · Contribute"
              title={tech.contribute.heading}
            />
            <p className="max-w-2xl text-[15px] leading-relaxed text-text-secondary">
              {tech.contribute.body}
            </p>
            <div className="mt-2">
              <PillLink
                href={tech.contribute.cta.href}
                icon={GitPullRequest}
                primary
              >
                {tech.contribute.cta.label}
              </PillLink>
            </div>
          </div>
        </section>

        {/* Page footer (small, factual) sits above the full Footer to
            keep the licensing line close to the page content. */}
        <div className="border-b border-border-subtle bg-bg-primary py-6">
          <div
            className="mx-auto px-6 text-center font-mono text-[11px] tracking-[0.1em] text-text-tertiary"
            style={{ maxWidth: "var(--container-xl)" }}
          >
            {tech.pageFooter}
          </div>
        </div>

        <Footer />
      </main>

      <ApplicationDock />
    </div>
  );
}

/* ---------------------------------------------------- helpers (file-local) */

// Single shared button geometry for every CTA on the page. The default
// variant is a dark pill that sits cleanly on bg-primary/secondary; the
// `primary` variant flips the bg to accent yellow with the same dark
// text so the two never look mismatched. Hover always lands on the
// accent border so both variants share a hover language.
function PillLink({
  href,
  icon: Icon,
  primary = false,
  children,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  primary?: boolean;
  children: React.ReactNode;
}) {
  // Color is set inline (not via text-accent-contrast / text-text-primary
  // utilities) because the cn() merge against text-[13px] was leaving
  // the wrong text color winning the cascade on this composition.
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: primary
          ? "var(--accent-contrast)"
          : "var(--text-primary)",
      }}
      className={cn(
        "group inline-flex h-11 items-center gap-2 rounded-lg border px-5 text-[13px] font-medium transition-all duration-200 select-none",
        primary
          ? "border-accent-primary bg-accent-primary hover:bg-accent-hover"
          : "border-border-default bg-bg-secondary hover:border-accent-border hover:bg-bg-tertiary",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span>{children}</span>
      <ArrowUpRight
        className={cn(
          "size-3.5 shrink-0 transition-transform duration-200 group-hover:-translate-y-px group-hover:translate-x-px",
          primary ? "opacity-80" : "opacity-60",
        )}
      />
    </a>
  );
}

function HeroStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] tracking-[0.18em] text-text-tertiary uppercase">
        {label}
      </span>
      <span
        className={
          accent
            ? "inline-flex items-center gap-2 text-[14px] font-medium text-accent-primary"
            : "text-[14px] font-medium text-text-primary"
        }
      >
        {accent && (
          <span className="size-1.5 animate-pulse rounded-full bg-accent-primary" />
        )}
        {value}
      </span>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = "center",
  compact = false,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  align?: "left" | "center";
  compact?: boolean;
}) {
  const alignClass = align === "center" ? "items-center text-center" : "items-start text-left";
  return (
    <div className={`flex flex-col gap-3 ${alignClass}`}>
      <span className="font-mono text-[10px] tracking-[0.22em] text-text-tertiary uppercase">
        {eyebrow}
      </span>
      <h2
        className={`font-display ${compact ? "text-[28px] sm:text-[32px]" : "text-[32px] sm:text-[40px]"} font-semibold tracking-tight text-text-primary`}
      >
        {title}
      </h2>
      {subtitle && (
        <p className="max-w-2xl text-[14px] leading-relaxed text-text-secondary">
          {subtitle}
        </p>
      )}
    </div>
  );
}

function FactCard({
  icon: Icon,
  label,
  value,
  mono = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 bg-bg-secondary p-6">
      <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.2em] text-text-tertiary uppercase">
        <Icon className="size-3.5 text-accent-primary" />
        {label}
      </div>
      <div
        className={
          mono
            ? "font-mono text-[12px] leading-relaxed break-all text-text-primary"
            : "text-[14px] font-medium text-text-primary"
        }
      >
        {value}
      </div>
    </div>
  );
}
