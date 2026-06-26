"use client";
import {
  useScroll,
  useTransform,
  motion,
} from "motion/react";
import React, { useEffect, useRef, useState } from "react";

interface TimelineEntry {
  title: string;
  content: React.ReactNode;
  // Optional override for the dot shown next to the title on the rail.
  // When provided, it REPLACES the default circle (border + inner dot)
  // but is still rendered inside the existing `absolute left-3` slot
  // so the timeline's sticky positioning is preserved. Used by the
  // Roadmap to wrap the active milestone's dot with an ElectricBorder.
  dot?: React.ReactNode;
  // Optional horizontal bridge rendered from the rail dot across the
  // gap and into the content card. Placed as an absolute child of the
  // sticky column with `left-8 right-[-56px] top-1/2` so it spans from
  // the dot center (x=32) to the card's left edge (x=sticky_col_w+56)
  // at any viewport. Painted at `z-[-1]` so the title text overlays it
  // cleanly without a visual strikethrough. Hidden below md — the
  // mobile layout has no rail / dot column to bridge.
  connector?: React.ReactNode;
}

export const Timeline = ({ data }: { data: TimelineEntry[] }) => {
  const ref = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setHeight(rect.height);
    }
  }, [ref]);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start 10%", "end 50%"],
  });

  const heightTransform = useTransform(scrollYProgress, [0, 1], [0, height]);
  const opacityTransform = useTransform(scrollYProgress, [0, 0.1], [0, 1]);

  return (
    <div className="relative w-full font-sans md:px-10" ref={containerRef}>
      <div ref={ref} className="relative mx-auto pb-10">
        {data.map((item, index) => (
          <div
            key={index}
            className="flex justify-start pt-6 md:gap-10 md:pt-16"
          >
            <div className="sticky top-40 z-40 flex max-w-xs flex-col items-center md:w-full md:max-w-sm md:flex-row lg:max-w-md">
              {/* Horizontal bridge from the rail dot to the card. Lives
                  inside the sticky col so its width is parametric in
                  sticky_col.width only — left=32 (dot center) and
                  right=-56 (sticky_col_w + 56 = card left edge at any
                  breakpoint since both columns are flex w-full with
                  md:gap-10 + pl-4). z-[-1] keeps it behind the static
                  title text so there's no strikethrough. */}
              {item.connector && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-8 hidden -translate-y-1/2 md:flex md:items-center"
                  style={{ right: "-56px", zIndex: -1 }}
                >
                  {item.connector}
                </div>
              )}
              {/* Dot is vertically centered within the (stretched) sticky
                  column so it aligns with the card's vertical midpoint
                  regardless of which row is in view. Previously used
                  `self-start` on the sticky column + `top: 0` on the dot,
                  which left tall active cards (ElectricBorder-wrapped)
                  visually above their dots. */}
              <div className="absolute top-1/2 left-3 -translate-y-1/2 md:left-3">
                {item.dot ?? (
                  <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border-default bg-bg-secondary">
                    <div className="h-3 w-3 rounded-full border border-accent-border bg-accent-muted" />
                  </div>
                )}
              </div>
              {/* Title sits on its own stacking level (z-auto inside a
                  z-40 sticky col); the connector below uses zIndex: -1
                  so it renders BEHIND the glyphs — the line passes
                  underneath the text letterforms cleanly, no chip,
                  no background, no strikethrough. */}
              <h3 className="relative hidden font-mono text-[14px] tracking-[0.18em] text-text-tertiary uppercase md:block md:pl-20 md:text-[20px]">
                {item.title}
              </h3>
            </div>

            <div className="relative w-full pr-4 pl-20 md:pl-4">
              <h3 className="mb-4 block text-left font-mono text-[12px] tracking-[0.18em] text-text-tertiary uppercase md:hidden">
                {item.title}
              </h3>
              {item.content}
            </div>
          </div>
        ))}
        <div
          style={{
            height: height + "px",
          }}
          className="absolute top-0 left-8 w-[2px] overflow-hidden bg-border-subtle [mask-image:linear-gradient(to_bottom,transparent_0%,black_10%,black_90%,transparent_100%)] md:left-8"
        >
          <motion.div
            style={{
              height: heightTransform,
              opacity: opacityTransform,
            }}
            className="absolute inset-x-0 top-0 w-[2px] rounded-full bg-accent-primary"
          />
        </div>
      </div>
    </div>
  );
};
