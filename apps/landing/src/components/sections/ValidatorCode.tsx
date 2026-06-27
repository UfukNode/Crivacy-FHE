"use client";

import { Code, GitBranch, ShieldCheck } from "lucide-react";

import FadeContent from "@/components/react-bits/FadeContent";
import GithubInlineComments from "@/components/ui/github-inline-comments";
import { SITE } from "@/lib/site";

export function ValidatorCode() {
  const { validatorCode } = SITE;

  return (
    <section
      id="validator-code"
      className="relative border-t border-border-subtle bg-bg-primary py-24"
    >
      <div
        className="mx-auto px-6"
        style={{ maxWidth: "var(--container-xl)" }}
      >
        <div className="grid gap-12 lg:grid-cols-3 lg:gap-16">
          {/* LEFT — Description (1 col) */}
          <FadeContent duration={800} threshold={0.2} className="lg:col-span-1">
            <div className="flex flex-col gap-6">
              <div className="inline-flex w-fit items-center gap-2 rounded-full border border-accent-border bg-accent-muted px-3 py-1 font-mono text-[10px] tracking-[0.18em] text-accent-primary uppercase">
                Open Source
              </div>
              <h2 className="text-[40px] leading-[1.1] font-semibold tracking-tight text-text-primary sm:text-[44px]">
                {validatorCode.heading}
              </h2>
              <p className="text-[15px] leading-relaxed text-text-secondary">
                {validatorCode.desc}
              </p>

              <ul className="mt-2 flex flex-col gap-3 text-[13px] text-text-secondary">
                <li className="flex items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-lg border border-accent-border bg-accent-muted text-accent-primary">
                    <Code className="size-4" strokeWidth={1.75} />
                  </span>
                  FHE-encrypted credential fields
                </li>
                <li className="flex items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-lg border border-accent-border bg-accent-muted text-accent-primary">
                    <ShieldCheck className="size-4" strokeWidth={1.75} />
                  </span>
                  Issued by operator, owned by holder
                </li>
                <li className="flex items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-lg border border-accent-border bg-accent-muted text-accent-primary">
                    <GitBranch className="size-4" strokeWidth={1.75} />
                  </span>
                  Per-firm access grants over the verdict
                </li>
              </ul>
            </div>
          </FadeContent>

          {/* RIGHT — GitHub-style diff (2 cols) */}
          <FadeContent
            duration={900}
            delay={120}
            threshold={0.15}
            className="lg:col-span-2"
          >
            <div className="overflow-hidden rounded-xl border border-border-default bg-bg-secondary">
              <GithubInlineComments
                diff={validatorCode.diff}
                fileName={validatorCode.fileName}
              />
            </div>
          </FadeContent>
        </div>
      </div>
    </section>
  );
}
