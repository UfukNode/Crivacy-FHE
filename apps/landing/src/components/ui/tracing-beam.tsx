"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  motion,
  useMotionValue,
  useTransform,
  useScroll,
} from "motion/react";
import { cn } from "@/lib/utils";

type StepAnchor = { y: number; iconLeftX: number };

// Offset above/below the middle icon center for entry (orange) / exit (green)
const MID_OFFSET = 14;
// Corner curve radius for smooth 90-degree turns
const CURVE_R = 8;

export const TracingBeam = ({
  children,
  className,
  auto = false,
  autoDurationMs = 8000,
  onProgress,
  activeStep = -1,
}: {
  children: React.ReactNode;
  className?: string;
  auto?: boolean;
  autoDurationMs?: number;
  onProgress?: (value: number) => void;
  activeStep?: number;
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: wrapperRef,
    offset: ["start start", "end start"],
  });

  const onProgressRef = useRef(onProgress);
  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  const autoProgress = useMotionValue(0);
  useEffect(() => {
    if (!auto) return;
    let start: number | null = null;
    let raf = 0;
    const tick = (t: number) => {
      if (start === null) start = t;
      const elapsed = (t - start) % autoDurationMs;
      const p = elapsed / autoDurationMs;
      autoProgress.set(p);
      onProgressRef.current?.(p);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [auto, autoDurationMs, autoProgress]);

  const progress = auto ? autoProgress : scrollYProgress;

  const contentRef = useRef<HTMLDivElement>(null);
  const [svgHeight, setSvgHeight] = useState(0);
  const [stepAnchors, setStepAnchors] = useState<StepAnchor[]>([]);

  const measure = useCallback(() => {
    if (!contentRef.current) return;
    const container = contentRef.current;
    const containerRect = container.getBoundingClientRect();
    setSvgHeight(container.offsetHeight);

    const lis = container.querySelectorAll<HTMLElement>(":scope li");
    const anchors: StepAnchor[] = [];
    lis.forEach((li) => {
      const icon = li.querySelector<HTMLElement>("article > div:first-child");
      if (icon) {
        const r = icon.getBoundingClientRect();
        anchors.push({
          y: r.top - containerRect.top + r.height / 2,
          iconLeftX: r.left - containerRect.left,
        });
      }
    });
    setStepAnchors(anchors);
  }, []);

  useEffect(() => {
    if (!contentRef.current) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, [measure]);

  const cappedHeight = Math.min(svgHeight, 600);

  // SVG coordinate mapping
  const beamSvgX = 30;
  const svgOffset = -72;
  const toSvgX = (contentX: number) => contentX - svgOffset;

  const svgWidth = Math.max(
    120,
    ...stepAnchors.map((a) => toSvgX(a.iconLeftX) + 10),
  );

  // ---------------------------------------------------------------------------
  // Segment paths with smooth curves at every 90-degree turn.
  //
  // 3-step layout (Submit → Credential Created → Use Everywhere):
  //   Segment A (orange): icon0 → LEFT → curve DOWN → DOWN → curve RIGHT →
  //                        enters mid icon ABOVE center
  //   Segment B (green):  exits mid icon BELOW center → LEFT → curve DOWN →
  //                        DOWN → curve RIGHT → icon2
  //
  // The middle step has NO dot — just two connector lines (entry above,
  // exit below) showing the beam entering orange and leaving green.
  // ---------------------------------------------------------------------------
  const segmentPaths: string[] = [];

  if (stepAnchors.length === 2) {
    const [a, b] = stepAnchors;
    const ax = toSvgX(a.iconLeftX);
    const bx = toSvgX(b.iconLeftX);
    segmentPaths.push(
      `M ${ax} ${a.y}` +
      ` H ${beamSvgX + CURVE_R}` +
      ` Q ${beamSvgX} ${a.y} ${beamSvgX} ${a.y + CURVE_R}` +
      ` V ${b.y - CURVE_R}` +
      ` Q ${beamSvgX} ${b.y} ${beamSvgX + CURVE_R} ${b.y}` +
      ` H ${bx}`,
    );
  } else if (stepAnchors.length >= 3) {
    const first = stepAnchors[0];
    const mid = stepAnchors[1];
    const last = stepAnchors[stepAnchors.length - 1];

    const firstX = toSvgX(first.iconLeftX);
    const midX = toSvgX(mid.iconLeftX);
    const lastX = toSvgX(last.iconLeftX);

    const entryY = mid.y - MID_OFFSET; // orange enters above center
    const exitY = mid.y + MID_OFFSET; // green exits below center

    // Segment A (orange): first icon → left → curve down → down →
    //                      curve right → mid icon (above center)
    segmentPaths.push(
      `M ${firstX} ${first.y}` +
      ` H ${beamSvgX + CURVE_R}` +
      ` Q ${beamSvgX} ${first.y} ${beamSvgX} ${first.y + CURVE_R}` +
      ` V ${entryY - CURVE_R}` +
      ` Q ${beamSvgX} ${entryY} ${beamSvgX + CURVE_R} ${entryY}` +
      ` H ${midX}`,
    );

    // Segment B (green): mid icon (below center) → left → curve down →
    //                     down → curve right → last icon
    segmentPaths.push(
      `M ${midX} ${exitY}` +
      ` H ${beamSvgX + CURVE_R}` +
      ` Q ${beamSvgX} ${exitY} ${beamSvgX} ${exitY + CURVE_R}` +
      ` V ${last.y - CURVE_R}` +
      ` Q ${beamSvgX} ${last.y} ${beamSvgX + CURVE_R} ${last.y}` +
      ` H ${lastX}`,
    );
  }

  const SEGMENT_STROKES = ["var(--beam-in)", "var(--beam-out)"];

  // ---------------------------------------------------------------------------
  // Animated dash offsets — staggered per segment
  // ---------------------------------------------------------------------------
  const segmentCount = Math.max(segmentPaths.length, 1);
  const segDuration = 1 / segmentCount;

  const dashOffsetA = useTransform(progress, (p: number) => {
    const t = Math.min(Math.max(p / segDuration, 0), 1);
    return 0.15 - t * 1.3;
  });

  const dashOffsetB = useTransform(progress, (p: number) => {
    const t = Math.min(Math.max((p - segDuration) / segDuration, 0), 1);
    return 0.15 - t * 1.3;
  });

  const dashOffsets = [dashOffsetA, dashOffsetB];

  // Dot active color: first dot = beam-in, last dot = beam-out
  const dotActiveColor = (i: number) =>
    i === 0 ? "var(--beam-in)" : "var(--beam-out)";

  return (
    <motion.div
      ref={wrapperRef}
      className={cn("relative mx-auto h-auto w-full max-w-4xl", className)}
    >
      <div ref={contentRef} className="relative">
        {children}

        {svgHeight > 0 && (
          <svg
            viewBox={`0 0 ${svgWidth} ${cappedHeight}`}
            width={svgWidth}
            height={cappedHeight}
            className="pointer-events-none absolute top-0 hidden md:block"
            style={{ left: svgOffset }}
            aria-hidden="true"
          >
            {/* ── Background tracks ── */}
            {segmentPaths.map((d, i) => (
              <path
                key={`bg-${i}`}
                d={d}
                fill="none"
                stroke="var(--text-tertiary)"
                strokeOpacity="0.12"
              />
            ))}

            {/* ── Animated beam segments ── */}
            {segmentPaths.map((d, i) => (
              <motion.path
                key={`beam-${i}`}
                d={d}
                pathLength={1}
                strokeDasharray="0.12 2"
                style={{ strokeDashoffset: dashOffsets[i] }}
                stroke={SEGMENT_STROKES[i] ?? SEGMENT_STROKES[SEGMENT_STROKES.length - 1]}
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="butt"
                className="motion-reduce:hidden"
              />
            ))}

            {/* ── Dots — first and last step only (middle uses entry/exit lines) ── */}
            {stepAnchors.map((a, i) => {
              if (i > 0 && i < stepAnchors.length - 1) return null;
              const active = i === activeStep;
              return (
                <circle
                  key={`dot-${i}`}
                  cx={beamSvgX}
                  cy={a.y}
                  r={active ? 4 : 2.5}
                  fill={active ? dotActiveColor(i) : "var(--text-tertiary)"}
                  className="transition-all duration-500"
                />
              );
            })}
          </svg>
        )}
      </div>
    </motion.div>
  );
};
