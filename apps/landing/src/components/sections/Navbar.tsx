"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { ArrowRight } from "lucide-react";

import GooeyNav from "@/components/react-bits/GooeyNav";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { CrivacyLogo } from "@/components/ui/crivacy-logo";
import { Button } from "@/components/ui/button";
import { SITE } from "@/lib/site";

// The Navbar CTA navigates to the live app on a different subdomain.
// Same-tab navigation matches the "Launch App" idiom — the visitor is
// leaving the marketing site and entering the product, so a new tab
// would feel like an interrupt, not a transition.
export function Navbar() {
  const pathname = usePathname();
  const onLanding = pathname === "/";

  // Anchor links (#section) only resolve to landing-page sections,
  // so when we're on another route (e.g. /tech) we prefix them with
  // "/" so the browser navigates back to landing then scrolls. The
  // GooeyNav anchor onClick doesn't preventDefault, so this href
  // drives the actual navigation. The "Tech" item gets its active
  // state when pathname is /tech; everywhere else GooeyNav falls
  // back to its first item as the visual default.
  const navItems = useMemo(
    () =>
      SITE.nav.links.map((link) =>
        link.href.startsWith("#") && !onLanding
          ? { label: link.label, href: `/${link.href}` }
          : { label: link.label, href: link.href },
      ),
    [onLanding],
  );

  const activeIndex = useMemo(() => {
    const idx = SITE.nav.links.findIndex((l) => l.href === pathname);
    return idx === -1 ? 0 : idx;
  }, [pathname]);

  const handleLaunch = () => {
    if (typeof window === "undefined") return;
    window.location.href = SITE.nav.ctaHref;
  };

  return (
    <header
      className="sticky top-0 z-50 border-b border-border-subtle backdrop-blur-md"
      style={{ backgroundColor: "color-mix(in srgb, var(--bg-primary) 75%, transparent)" }}
    >
      <div
        className="mx-auto flex h-16 items-center justify-between px-6"
        style={{ maxWidth: "var(--container-xl)" }}
      >
        {/* Logo — inline SVG, currentColor inherits from text-text-primary.
            Always routes to "/" so the logo is a true "home" link on every
            route (on /tech etc.), not an in-page anchor. */}
        <Link
          href="/"
          className="group flex items-center text-text-primary transition-colors hover:text-accent-primary"
          aria-label="Crivacy home"
        >
          <CrivacyLogo className="h-7 w-auto" />
        </Link>

        {/* Center — GooeyNav (hidden on small screens). The `key` on
            pathname forces a remount when the route changes so the
            `initialActiveIndex` re-applies — without this, switching
            from / to /tech wouldn't update the highlighted item. */}
        <nav className="hidden md:block">
          <GooeyNav
            key={pathname}
            items={navItems}
            initialActiveIndex={activeIndex}
            particleCount={12}
            animationTime={550}
          />
        </nav>

        {/* Right — theme toggle + CTA */}
        <div className="flex items-center gap-3">
          <AnimatedThemeToggler
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary [&>svg]:size-4"
          />
          <Button
            onClick={handleLaunch}
            className="h-9 px-4 text-[13px] font-medium"
          >
            <span className="inline-flex items-center gap-1.5">
              {SITE.nav.cta}
              <ArrowRight
                className="size-3.5 animate-nudge-right"
                strokeWidth={2}
              />
            </span>
          </Button>
        </div>
      </div>
    </header>
  );
}
