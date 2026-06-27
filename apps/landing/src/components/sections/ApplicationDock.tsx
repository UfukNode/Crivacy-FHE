"use client";

import { useEffect, useRef, useState } from "react";

import Dock from "@/components/react-bits/Dock";
import { SITE } from "@/lib/site";

// ApplicationDock — floating dock anchored to the bottom of the viewport.
// It renders one monochrome SVG per social / external link from
// `site.footer.dock` using CSS `mask-image`, so the tint always follows
// the active theme token (`--text-secondary` on idle, `--accent-primary`
// on hover). The dock itself is taken verbatim from react-bits
// (`components/react-bits/Dock.tsx`) — we only supply item data and wrap
// it in a fixed-position container.
//
// Scroll behaviour:
//   - Fades out while the user is actively scrolling so it never hides
//     page content during long scrolls.
//   - Fades back in 2 s after the last scroll event (debounced). The
//     delay gives the wave a "stopped and settled" feel instead of
//     blinking back the moment momentum scroll decelerates.
//
// Layout notes:
//   - Outer wrapper is `fixed inset-x-0 bottom-4 z-50` with
//     `pointer-events-none` so it never blocks clicks on the page behind.
//   - Inner wrapper re-enables pointer events only over the dock width.
//   - The react-bits Dock uses `absolute bottom-2 left-1/2` internally,
//     so we give it a sized `relative` parent (h-20 w-fit) to place the
//     panel. This mirrors the footer usage pattern the old site used
//     before the dock was lifted out.
export function ApplicationDock() {
  const { footer } = SITE;

  // `visible` drives both opacity and pointer-events. Starts visible so
  // the dock is available on first paint before any scroll happens.
  const [visible, setVisible] = useState(true);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const handleScroll = () => {
      setVisible(false);
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
      hideTimerRef.current = window.setTimeout(() => {
        setVisible(true);
        hideTimerRef.current = null;
      }, 500);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, []);

  const dockItems = footer.dock.map((item) => ({
    icon: (
      <span
        aria-hidden="true"
        className="block size-5 bg-text-secondary transition-colors duration-200 group-hover:bg-accent-primary"
        style={{
          maskImage: `url(${item.icon})`,
          WebkitMaskImage: `url(${item.icon})`,
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
        }}
      />
    ),
    label: item.label,
    // `group` lets the icon <span> react to hover via `group-hover:`.
    // `cursor-pointer` signals the dock items are clickable (the
    // react-bits Dock defaults to cursor: default because it sets
    // `role="button"` without a cursor class).
    className: "group cursor-pointer",
    onClick: () => {
      if (typeof window === "undefined") return;
      window.open(item.href, "_blank", "noopener,noreferrer");
    },
  }));

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center transition-opacity duration-500 ease-out"
      style={{ opacity: visible ? 1 : 0 }}
      aria-hidden={!visible}
      aria-label="Application dock wrapper"
    >
      <div
        className="relative h-20 w-fit"
        style={{ pointerEvents: visible ? "auto" : "none" }}
      >
        <Dock
          items={dockItems}
          panelHeight={56}
          baseItemSize={40}
          magnification={58}
          distance={140}
        />
      </div>
    </div>
  );
}
