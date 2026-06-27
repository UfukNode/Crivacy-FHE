"use client";

import {
  forwardRef,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SVGProps,
} from "react";
import {
  Fingerprint,
  Globe,
  Shield,
  User,
  type LucideIcon,
} from "lucide-react";

import FadeContent from "@/components/react-bits/FadeContent";
import { AnimatedBeam } from "@/components/ui/animated-beam";
import { TracingBeam } from "@/components/ui/tracing-beam";
import { SITE } from "@/lib/site";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  Fingerprint,
  Shield,
  Globe,
};

// Auto-flow duration for the beam + step highlight cycle. Keep in sync with
// the `autoDurationMs` prop passed to TracingBeam below.
const CYCLE_MS = 6500;

// ---------------------------------------------------------------------------
// Beam diagram config
// ---------------------------------------------------------------------------
// Each entry drives one output circle + one beam on the right side of the
// diagram. Data-driven so node count + fan geometry + beam timing are all
// centralized — no magic numbers live inside the JSX.
type BeamNode = {
  id: string;
  label: string;
  curvature: number;
  endYOffset: number;
  delay: number;
};

const BEAM_APPS: readonly BeamNode[] = [
  { id: "app-1", label: "APP-1", curvature: -75, endYOffset: -10, delay: 0 },
  { id: "app-2", label: "APP-2", curvature: -20, endYOffset: -10, delay: 0.5 },
  { id: "app-3", label: "APP-3", curvature: 0, endYOffset: 0, delay: 1 },
  { id: "app-4", label: "APP-4", curvature: 20, endYOffset: 10, delay: 1.5 },
  { id: "app-5", label: "APP-5", curvature: 75, endYOffset: 10, delay: 2 },
] as const;

// 3 incoming user nodes on the left. Beam direction is user → Crivacy, so
// curvature here shapes the INCOMING fan (mirrored version of the BEAM_APPS
// spray). startYOffset slightly offsets the beam anchor on the top/bottom
// users so the curves land cleanly on Crivacy's center without kinking.
type BeamUser = {
  id: string;
  curvature: number;
  startYOffset: number;
  delay: number;
};

const BEAM_USERS: readonly BeamUser[] = [
  { id: "user-1", curvature: -40, startYOffset: -10, delay: 0 },
  { id: "user-2", curvature: 0, startYOffset: 0, delay: 0.7 },
  { id: "user-3", curvature: 40, startYOffset: 10, delay: 1.4 },
] as const;

// ---------------------------------------------------------------------------
// Inline Crivacy star mark
// ---------------------------------------------------------------------------
// The shared <CrivacyLogo /> renders the full wordmark. In a small circle the
// wordmark is unreadable, so we render only the star glyph here via a
// restricted viewBox (0..200). This keeps the beam diagram visually centered
// on the mark without touching the shared logo component.
function CrivacyMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 200 168.71"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <polygon points="200 28.52 195.87 69.04 118.25 120.34 100 168.71 81.75 120.34 4.13 69.04 0 28.52 42.65 60.42 87.65 49.66 100 0 112.35 49.66 157.35 60.42 200 28.52" />
      <path d="M16.06,90.54c6.97,4.17,13.94,8.33,20.91,12.5-.73,1.32-1.64,3.18-2.39,5.53,0,0-.76,2.87-1.21,5.5-.6,3.54-.15,11.95,6.17,17.95,5.82,5.52,14.23,6.72,19.82,4.78,3.73-1.29,7.07-3.4,8-4.09,2.26-1.67,3.88-3.41,4.96-4.72,1.5,2.17,3.58,5.79,4.61,10.69.64,3.07.68,5.76.55,7.82-7.85,6.31-15.7,12.62-23.55,18.93l-46.87-30.98,9-43.92Z" />
      <path d="M182.89,90.54c-6.97,4.17-13.94,8.33-20.91,12.5.73,1.32,1.64,3.18,2.39,5.53,0,0,.76,2.87,1.21,5.5.6,3.54.15,11.95-6.17,17.95-5.82,5.52-14.23,6.72-19.82,4.78-3.73-1.29-7.07-3.4-8-4.09-2.26-1.67-3.88-3.41-4.96-4.72-1.5,2.17-3.58,5.79-4.61,10.69-.64,3.07-.68,5.76-.55,7.82,7.85,6.31,15.7,12.62,23.55,18.93l46.87-30.98-9-43.92Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Circle primitive
// ---------------------------------------------------------------------------
// Token-styled node used by the beam diagram. forwardRef is required because
// AnimatedBeam reads real DOM rects via refs to compute bezier paths.
interface CircleProps {
  className?: string;
  children?: ReactNode;
}
const Circle = forwardRef<HTMLDivElement, CircleProps>(function Circle(
  { className, children },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "z-10 flex size-14 items-center justify-center rounded-full border border-border-default bg-bg-secondary p-2 text-text-primary shadow-[var(--shadow-md)]",
        className,
      )}
    >
      {children}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Animated beam — Crivacy multi-output diagram
// ---------------------------------------------------------------------------
function AnimatedBeamMultipleOutputs({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const crivacyRef = useRef<HTMLDivElement | null>(null);

  // Stable arrays of ref objects — one per BEAM_USERS / BEAM_APPS entry.
  // useMemo with [] keeps each { current } identity-stable across renders so
  // AnimatedBeam's useEffect does NOT re-run on every parent update.
  const userRefs = useMemo(
    () => BEAM_USERS.map(() => ({ current: null as HTMLDivElement | null })),
    [],
  );
  const appRefs = useMemo(
    () => BEAM_APPS.map(() => ({ current: null as HTMLDivElement | null })),
    [],
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative flex h-full w-full items-center justify-center p-6 sm:p-8",
        className,
      )}
    >
      <div className="flex size-full max-w-sm flex-row items-stretch justify-between gap-6 sm:max-w-md sm:gap-10">
        {/* LEFT — 3 user input nodes fanned vertically (mirror of the app column) */}
        <div className="flex flex-col justify-center gap-3">
          {BEAM_USERS.map((user, i) => (
            <Circle
              key={user.id}
              ref={(el) => {
                userRefs[i].current = el;
              }}
            >
              <User className="size-5 text-text-primary" strokeWidth={1.75} />
            </Circle>
          ))}
        </div>

        {/* CENTER — Crivacy mark (larger circle for emphasis) */}
        <div className="flex flex-col justify-center">
          <Circle
            ref={crivacyRef}
            className="size-20 border-accent-border bg-bg-tertiary text-accent-primary"
          >
            <CrivacyMark className="h-8 w-8" />
          </Circle>
        </div>

        {/* RIGHT — app outputs fanned vertically */}
        <div className="flex flex-col justify-center gap-3">
          {BEAM_APPS.map((app, i) => (
            <Circle
              key={app.id}
              ref={(el) => {
                appRefs[i].current = el;
              }}
              className="size-14 border-accent-border bg-bg-secondary text-accent-primary"
            >
              <span className="font-mono text-[9px] leading-none tracking-[0.04em] text-accent-primary">
                {app.label}
              </span>
            </Circle>
          ))}
        </div>
      </div>

      {/* User-N → Crivacy (fanned) */}
      {BEAM_USERS.map((user, i) => (
        <AnimatedBeam
          key={user.id}
          containerRef={containerRef}
          fromRef={userRefs[i]}
          toRef={crivacyRef}
          curvature={user.curvature}
          startYOffset={user.startYOffset}
          duration={4}
          delay={user.delay}
          gradientStartColor="var(--accent-primary)"
          gradientStopColor="var(--accent-hover)"
          pathColor="var(--border-default)"
          pathOpacity={0.25}
        />
      ))}

      {/* Crivacy → each APP-N (fanned) */}
      {BEAM_APPS.map((app, i) => (
        <AnimatedBeam
          key={app.id}
          containerRef={containerRef}
          fromRef={crivacyRef}
          toRef={appRefs[i]}
          curvature={app.curvature}
          endYOffset={app.endYOffset}
          duration={4}
          delay={app.delay}
          gradientStartColor="var(--accent-primary)"
          gradientStopColor="var(--accent-hover)"
          pathColor="var(--border-default)"
          pathOpacity={0.25}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------
export function HowItWorks() {
  const stepCount = SITE.howItWorks.steps.length;
  const [activeStep, setActiveStep] = useState(0);

  return (
    <section
      id="how-it-works"
      className="relative border-t border-border-subtle bg-bg-primary py-24"
    >
      <div
        className="mx-auto px-6"
        style={{ maxWidth: "var(--container-xl)" }}
      >
        {/* Heading — centered, no badge */}
        <FadeContent duration={800} delay={0} threshold={0.2}>
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-[40px] leading-[1.1] font-semibold tracking-tight text-text-primary sm:text-[48px]">
              {SITE.howItWorks.heading}
            </h2>
            <p className="mx-auto mt-4 max-w-md text-center text-[15px] leading-relaxed text-text-secondary">
              {SITE.howItWorks.subheading}
            </p>
          </div>
        </FadeContent>

        {/* Two-column layout on lg: steps (with TracingBeam) + beam diagram.
            Mobile stacks naturally — steps first, beam diagram second. */}
        <div className="mt-16 grid items-stretch gap-12 lg:grid-cols-2 lg:gap-16">
          {/* LEFT — TracingBeam + step cards */}
          <div className="flex min-w-0 items-center">
            <TracingBeam
              auto
              autoDurationMs={CYCLE_MS}
              className="!max-w-xl"
              activeStep={activeStep}
              onProgress={(p) => {
                const idx = Math.min(
                  Math.floor(p * stepCount),
                  stepCount - 1,
                );
                setActiveStep((prev) => (prev === idx ? prev : idx));
              }}
            >
              <ol className="flex flex-col gap-14">
                {SITE.howItWorks.steps.map((step, idx) => {
                  const Icon = ICONS[step.icon] ?? Shield;
                  const isActive = idx === activeStep;
                  return (
                    <FadeContent
                      key={step.step}
                      duration={900}
                      delay={idx * 120}
                      threshold={0.2}
                    >
                      <li
                        className={cn(
                          "transition-[opacity,transform] duration-500 ease-out",
                          isActive
                            ? "translate-x-0 opacity-100"
                            : "translate-x-0 opacity-40",
                        )}
                      >
                        <article className="flex items-start gap-5">
                          <div
                            className={cn(
                              "flex size-12 shrink-0 items-center justify-center rounded-lg border bg-accent-muted text-accent-primary transition-all duration-500 ease-out",
                              isActive
                                ? "scale-110 border-accent-primary"
                                : "scale-100 border-accent-border",
                            )}
                          >
                            <Icon className="size-5" strokeWidth={1.75} />
                          </div>
                          <div className="flex-1 space-y-2">
                            <div className="flex items-baseline gap-3">
                              <span
                                className={cn(
                                  "font-mono text-[11px] tracking-widest uppercase transition-colors duration-500",
                                  isActive
                                    ? "text-accent-primary"
                                    : "text-text-tertiary",
                                )}
                              >
                                Step {String(step.step).padStart(2, "0")}
                              </span>
                            </div>
                            <h3 className="text-[22px] leading-tight font-semibold text-text-primary">
                              {step.title}
                            </h3>
                            <p className="max-w-xl text-[14px] leading-relaxed text-text-secondary">
                              {step.desc}
                            </p>
                          </div>
                        </article>
                      </li>
                    </FadeContent>
                  );
                })}
              </ol>
            </TracingBeam>
          </div>

          {/* RIGHT — AnimatedBeam Multiple Outputs diagram */}
          <FadeContent duration={1000} delay={200} threshold={0.15}>
            <div className="lg:sticky lg:top-24">
              <AnimatedBeamMultipleOutputs />
            </div>
          </FadeContent>
        </div>
      </div>
    </section>
  );
}
