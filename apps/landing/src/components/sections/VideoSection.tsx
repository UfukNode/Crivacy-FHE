"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Activity, ChevronLeft, ChevronRight } from "lucide-react";

import FadeContent from "@/components/react-bits/FadeContent";
import { AnimatedList } from "@/components/ui/animated-list";
import { SafeTweet } from "@/components/ui/safe-tweet";
import { SITE } from "@/lib/site";
import { cn } from "@/lib/utils";

// Initial reveal cadence for the AnimatedList and infinite rotation interval.
// Kept here so both the parent-driven rotation and the AnimatedList internal
// reveal loop stay in sync.
const LIVE_REVEAL_DELAY = 650;
const LIVE_ROTATION_MS = 2000;

// ---------------------------------------------------------------------------
// FeedItem — single row of the live credential activity feed
// ---------------------------------------------------------------------------
function FeedItem({
  city,
  when,
  action,
}: {
  city: string;
  when: string;
  action: string;
}) {
  return (
    <div className="relative flex w-full items-center gap-3 rounded-xl border border-border-subtle bg-bg-secondary/80 p-3 backdrop-blur-sm">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-accent-border bg-accent-muted text-accent-primary">
        <Activity className="size-4" strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13px] font-medium text-text-primary">
            {action}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-text-tertiary">
            {when}
          </span>
        </div>
        <span className="font-mono text-[11px] tracking-wide text-text-secondary uppercase">
          {city}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------
type FeedRow = (typeof SITE.video.feed)[number] & { _k: string };

export function VideoSection() {
  const { video } = SITE;
  const tweetCount = video.tweets.length;

  // --- Tweet carousel (left column) --------------------------------------
  const [tweetIndex, setTweetIndex] = useState(0);

  useEffect(() => {
    if (tweetCount <= 1) return;
    const id = window.setInterval(() => {
      setTweetIndex((i) => (i + 1) % tweetCount);
    }, 9000);
    return () => window.clearInterval(id);
  }, [tweetCount]);

  const prevTweet = () =>
    setTweetIndex((i) => (i - 1 + tweetCount) % tweetCount);
  const nextTweet = () => setTweetIndex((i) => (i + 1) % tweetCount);

  // --- Live feed (right column) ------------------------------------------
  // The feed MUST NOT start animating until the user scrolls it into view.
  // IntersectionObserver with threshold 0.3 means the section must be
  // ~30% visible before the reveal + rotation kicks in.
  const feedRef = useRef<HTMLDivElement | null>(null);
  const [feedInView, setFeedInView] = useState(false);

  useEffect(() => {
    if (feedInView) return;
    const node = feedRef.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setFeedInView(true);
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.3 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [feedInView]);

  // Rotating feed state — each tick, the head item rotates to the tail with
  // a fresh React key. AnimatedList sees a children array whose length is
  // stable but whose trailing item has a new key, so AnimatePresence plays
  // an enter animation at the top of the stack (stream effect).
  const initialFeed = useMemo<FeedRow[]>(
    () => video.feed.map((item, i) => ({ ...item, _k: `seed-${i}` })),
    [video.feed],
  );
  const [liveFeed, setLiveFeed] = useState<FeedRow[]>(initialFeed);

  // Kick off infinite rotation after the initial sequential reveal finishes.
  // The reveal takes roughly feed.length * LIVE_REVEAL_DELAY; we add a small
  // buffer so the last item fully settles before rotation begins.
  const [rotationStarted, setRotationStarted] = useState(false);

  useEffect(() => {
    if (!feedInView) return;
    const revealMs = video.feed.length * LIVE_REVEAL_DELAY + 400;
    const timer = window.setTimeout(() => setRotationStarted(true), revealMs);
    return () => window.clearTimeout(timer);
  }, [feedInView, video.feed.length]);

  useEffect(() => {
    if (!rotationStarted) return;
    const id = window.setInterval(() => {
      setLiveFeed((prev) => {
        const [first, ...rest] = prev;
        return [...rest, { ...first, _k: `${first.city}-${Date.now()}` }];
      });
    }, LIVE_ROTATION_MS);
    return () => window.clearInterval(id);
  }, [rotationStarted]);

  return (
    <section
      id="network"
      className="relative border-t border-border-subtle bg-bg-primary py-24"
    >
      <div
        className="mx-auto px-6"
        style={{ maxWidth: "var(--container-xl)" }}
      >
        {/* Heading — no Watch badge (moved to HowItWorks) */}
        <FadeContent duration={800} threshold={0.2}>
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-[40px] leading-[1.1] font-semibold tracking-tight text-text-primary sm:text-[48px]">
              {video.heading}
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-center text-[15px] leading-relaxed text-text-secondary">
              {video.subheading}
            </p>
          </div>
        </FadeContent>

        {/* Row layout — LEFT: Tweet carousel, RIGHT: Live credential feed */}
        <div className="mt-16 grid items-start gap-12 lg:grid-cols-2">
          {/* LEFT — Community tweets carousel. Fixed height so swapping
              tweets never shifts the layout. */}
          <FadeContent duration={900} delay={120} threshold={0.15}>
            <div className="flex w-full justify-center lg:justify-end">
              <div className="relative mx-auto w-full max-w-[460px] lg:mx-0">
                {/* No outer chrome here — react-tweet renders its own card
                    (background, border, rounded corners) via the
                    .crivacy-tweet-wrapper overrides in globals.css. Wrapping
                    it in a second bg-bg-secondary card with its own border
                    produced a double-frame with a 16px dead zone between
                    them. The wrapper is now a transparent, fixed-height
                    slot that just clips the scrolling slide and hosts the
                    absolutely-positioned chevrons. */}
                <div className="relative h-[468px] w-full overflow-hidden rounded-xl">
                  {video.tweets.map((tweet, i) => (
                    <div
                      key={tweet.id}
                      aria-hidden={i !== tweetIndex}
                      className={cn(
                        "absolute inset-0 overflow-y-auto transition-opacity duration-500 ease-out",
                        i === tweetIndex
                          ? "opacity-100"
                          : "pointer-events-none opacity-0",
                      )}
                    >
                      <div className="crivacy-tweet-wrapper">
                        <SafeTweet id={tweet.id} />
                      </div>
                    </div>
                  ))}

                  {/* Prev / next chevrons */}
                  {tweetCount > 1 && (
                    <>
                      <button
                        type="button"
                        aria-label="Previous tweet"
                        onClick={prevTweet}
                        className="absolute top-1/2 left-2 z-10 -translate-y-1/2 rounded-full border border-border-default bg-bg-primary/60 p-1.5 text-text-primary backdrop-blur-md transition-colors hover:border-accent-border hover:text-accent-primary"
                      >
                        <ChevronLeft className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="Next tweet"
                        onClick={nextTweet}
                        className="absolute top-1/2 right-2 z-10 -translate-y-1/2 rounded-full border border-border-default bg-bg-primary/60 p-1.5 text-text-primary backdrop-blur-md transition-colors hover:border-accent-border hover:text-accent-primary"
                      >
                        <ChevronRight className="size-4" />
                      </button>
                    </>
                  )}
                </div>

                {/* Dots */}
                {tweetCount > 1 && (
                  <div className="mt-4 flex items-center justify-center gap-2">
                    {video.tweets.map((tweet, i) => (
                      <button
                        key={tweet.id}
                        type="button"
                        aria-label={`Show tweet ${i + 1}`}
                        aria-current={i === tweetIndex}
                        onClick={() => setTweetIndex(i)}
                        className={cn(
                          "h-1.5 rounded-full transition-all duration-300",
                          i === tweetIndex
                            ? "w-8 bg-accent-primary"
                            : "w-1.5 bg-border-default hover:bg-accent-border",
                        )}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </FadeContent>

          {/* RIGHT — Live credential activity feed. AnimatedList only
              mounts once the block has entered the viewport so the reveal
              animation is never missed by off-screen ticks. */}
          <FadeContent duration={1000} delay={200} threshold={0.15}>
            <div className="flex w-full justify-center lg:justify-start">
              <div
                ref={feedRef}
                className="relative mx-auto w-full max-w-[460px] lg:mx-0"
              >
                <div className="mb-4 flex items-center justify-between px-1">
                  <span className="font-mono text-[10px] tracking-[0.18em] text-text-tertiary uppercase">
                    Live Feed
                  </span>
                  <span className="flex items-center gap-1.5 font-mono text-[10px] text-accent-primary">
                    <span className="size-1.5 rounded-full bg-accent-primary" />
                    Streaming
                  </span>
                </div>

                <div className="animate-breathe relative h-[442px] w-full overflow-hidden rounded-xl border bg-bg-secondary/40 p-4">
                  {feedInView ? (
                    <AnimatedList
                      delay={LIVE_REVEAL_DELAY}
                      className="!items-stretch"
                    >
                      {liveFeed.map((item) => (
                        <FeedItem
                          key={item._k}
                          city={item.city}
                          when={item.when}
                          action={item.action}
                        />
                      ))}
                    </AnimatedList>
                  ) : (
                    // Pre-mount placeholder — keeps layout stable without
                    // starting any animation before the user scrolls in.
                    <div
                      aria-hidden="true"
                      className="pointer-events-none flex h-full w-full items-center justify-center"
                    >
                      <span className="font-mono text-[11px] tracking-[0.18em] text-text-tertiary/40 uppercase">
                        Awaiting live activity…
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </FadeContent>
        </div>
      </div>
    </section>
  );
}
