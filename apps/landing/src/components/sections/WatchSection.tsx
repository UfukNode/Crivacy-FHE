"use client";

import { useEffect, useRef, useState } from "react";

import { Play } from "lucide-react";

import FadeContent from "@/components/react-bits/FadeContent";
import LightRays from "@/components/react-bits/LightRays";
import { HeroVideoDialog } from "@/components/ui/hero-video-dialog";
import { VideoText } from "@/components/ui/video-text";
import { SITE } from "@/lib/site";
import { useThemeColors } from "@/lib/use-theme-colors";
import { useTheme } from "@/components/theme-provider";

// ---------------------------------------------------------------------------
// WatchSection — standalone block hosting the VideoText mask + play trigger.
// Sits between HowItWorks and Features in page.tsx, following the same
// section shell as its neighbours (border-t separator + py-24). The section
// is forced to dark theme via `data-theme="dark"` because the VideoText
// mask + LightRays both depend on a dark backdrop to read properly.
// ---------------------------------------------------------------------------
export function WatchSection() {
  const { video } = SITE;
  const colors = useThemeColors();
  const { theme } = useTheme();

  // Lazy-mount VideoText (which starts the 28 MB crivacy-intro.mp4 download)
  // only after the block approaches the viewport. First paint stays light.
  const maskRef = useRef<HTMLDivElement | null>(null);
  const [maskInView, setMaskInView] = useState(false);

  useEffect(() => {
    if (maskInView) return;
    const node = maskRef.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setMaskInView(true);
            io.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [maskInView]);

  return (
    <section
      id="watch"
      className="relative overflow-hidden border-t border-border-subtle bg-bg-primary py-24"
    >
      {/* Light rays — full-section WebGL background, behind all content.
          pointer-events-none so it never intercepts clicks on the Watch
          trigger that sits above it. IntersectionObserver inside the
          component itself pauses the render loop when off-screen. */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <LightRays
          raysOrigin="top-center"
          raysColor={colors.rayTint}
          raysSpeed={1.6}
          lightSpread={1.1}
          rayLength={1.2}
          fadeDistance={0.85}
          saturation={0.55}
          followMouse
          mouseInfluence={0.1}
          noiseAmount={0}
          distortion={0.02}
        />
      </div>

      <div
        className="relative z-10 mx-auto px-6"
        style={{ maxWidth: "var(--container-xl)" }}
      >
        <FadeContent duration={900} threshold={0.15}>
          <div className="mx-auto flex w-full max-w-4xl flex-col items-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-accent-border bg-accent-muted px-4 py-1.5 font-mono text-[12px] tracking-[0.2em] text-accent-primary uppercase">
              Watch Our Intro
            </div>

            <div
              ref={maskRef}
              className="relative mt-6 w-full"
            >
              <HeroVideoDialog
                animationStyle="from-center"
                videoSrc={video.videoSrc}
                className="block w-full"
              >
                <div className="relative h-[220px] w-full overflow-hidden sm:h-[300px] md:h-[380px] lg:h-[440px]">
                  {maskInView ? (
                    <VideoText
                      src={video.videoSrc}
                      fontSize={22}
                      fontWeight={700}
                      fontFamily="Satoshi, system-ui, sans-serif"
                      className="pointer-events-none w-full"
                    >
                      {video.textMask}
                    </VideoText>
                  ) : (
                    // Placeholder — layout-stable, zero network traffic.
                    <div
                      aria-hidden="true"
                      className="pointer-events-none flex h-full w-full items-center justify-center"
                    >
                      <span
                        className="text-[22vw] leading-none font-bold tracking-tight text-text-tertiary/20 select-none"
                        style={{ fontFamily: "Satoshi, system-ui, sans-serif" }}
                      >
                        {video.textMask}
                      </span>
                    </div>
                  )}

                  {/* Centered play button overlay — pointer-events-none so
                      the parent trigger captures clicks uniformly. */}
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="flex size-24 items-center justify-center rounded-full border border-accent-border bg-bg-primary/50 backdrop-blur-md transition-transform duration-300 ease-out group-hover:scale-110">
                      <div className="flex size-16 items-center justify-center rounded-full border border-accent-border bg-accent-muted">
                        <Play
                          className="ml-0.5 size-6 fill-accent-primary text-accent-primary"
                          strokeWidth={1.75}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </HeroVideoDialog>
            </div>
          </div>
        </FadeContent>
      </div>
    </section>
  );
}
