"use client";

import ScrambledText from "@/components/react-bits/ScrambledText";
import { SITE } from "@/lib/site";

// Footer renders the brand blurb, link columns and copyright. The
// social / external-link dock that used to live in the bottom row has
// been lifted out into <ApplicationDock /> (rendered from page.tsx) so
// it can float fixed at the bottom of the viewport and stay visible on
// every scroll position.
export function Footer() {
  const { footer } = SITE;

  return (
    <footer
      id="footer"
      className="relative border-t border-border-subtle bg-bg-primary"
    >
      <div
        className="mx-auto px-6 pt-20 pb-10"
        style={{ maxWidth: "var(--container-xl)" }}
      >
        {/* Brand (wider) + 5 link columns. Drops to a 2-col link grid
            on small screens, full single column on mobile. */}
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr_1fr] lg:gap-10">
          {/* Brand column */}
          <div className="flex flex-col gap-4">
            <div className="font-mono text-[13px] tracking-[0.22em] text-text-primary uppercase">
              {SITE.name.toUpperCase()}
            </div>
            <p className="max-w-xs text-[13px] leading-relaxed text-text-secondary">
              {footer.blurb}
            </p>
          </div>

          {/* Link columns */}
          {footer.columns.map((col) => (
            <div key={col.heading} className="flex flex-col gap-4">
              <h4 className="font-mono text-[10px] tracking-[0.18em] text-text-tertiary uppercase">
                {col.heading}
              </h4>
              <ul className="flex flex-col gap-2.5">
                {col.links.map((link) => {
                  const external = link.href.startsWith("http");
                  return (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        {...(external
                          ? { target: "_blank", rel: "noopener noreferrer" }
                          : {})}
                        className="text-[13px] text-text-secondary transition-colors hover:text-accent-primary"
                      >
                        {link.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        {/* Divider */}
        <div className="mt-16 border-t border-border-subtle" />

        {/* Bottom row: built-on attribution + copyright. Extra bottom
            padding leaves room for the floating ApplicationDock so it
            never covers the text. */}
        <div className="mt-8 flex flex-col items-center gap-3 pb-24 text-[11px] text-text-tertiary">
          <p className="text-center">
            Powered by Zama FHE. Open source at{" "}
            <a
              href="https://github.com/crivacy-io"
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-secondary underline decoration-border-default underline-offset-4 transition-colors hover:text-accent-primary hover:decoration-accent-primary"
            >
              github.com/crivacy-io
            </a>
          </p>
          <ScrambledText
            radius={60}
            duration={1}
            speed={0.6}
            scrambleChars=".:/\\"
            className="!font-sans"
          >
            {footer.copyright}
          </ScrambledText>
        </div>
      </div>
    </footer>
  );
}
