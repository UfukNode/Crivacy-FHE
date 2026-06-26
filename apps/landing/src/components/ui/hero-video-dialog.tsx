"use client"

import { useEffect, useState, type ReactNode } from "react"
import { Play, XIcon } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"

import { cn } from "@/lib/utils"

type AnimationStyle =
  | "from-bottom"
  | "from-center"
  | "from-top"
  | "from-left"
  | "from-right"
  | "fade"
  | "top-in-bottom-out"
  | "left-in-right-out"

interface HeroVideoProps {
  animationStyle?: AnimationStyle
  videoSrc: string
  thumbnailSrc?: string
  thumbnailAlt?: string
  className?: string
  /**
   * Optional custom trigger. When provided, replaces the default
   * thumbnail+play-button button and uses the supplied node as the
   * clickable area (VideoSection passes a VideoText + play overlay).
   */
  children?: ReactNode
}

const animationVariants = {
  "from-bottom": {
    initial: { y: "100%", opacity: 0 },
    animate: { y: 0, opacity: 1 },
    exit: { y: "100%", opacity: 0 },
  },
  "from-center": {
    initial: { scale: 0.5, opacity: 0 },
    animate: { scale: 1, opacity: 1 },
    exit: { scale: 0.5, opacity: 0 },
  },
  "from-top": {
    initial: { y: "-100%", opacity: 0 },
    animate: { y: 0, opacity: 1 },
    exit: { y: "-100%", opacity: 0 },
  },
  "from-left": {
    initial: { x: "-100%", opacity: 0 },
    animate: { x: 0, opacity: 1 },
    exit: { x: "-100%", opacity: 0 },
  },
  "from-right": {
    initial: { x: "100%", opacity: 0 },
    animate: { x: 0, opacity: 1 },
    exit: { x: "100%", opacity: 0 },
  },
  fade: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
  },
  "top-in-bottom-out": {
    initial: { y: "-100%", opacity: 0 },
    animate: { y: 0, opacity: 1 },
    exit: { y: "100%", opacity: 0 },
  },
  "left-in-right-out": {
    initial: { x: "-100%", opacity: 0 },
    animate: { x: 0, opacity: 1 },
    exit: { x: "100%", opacity: 0 },
  },
}

// Detect direct-playable media (local file or same-origin .mp4/.webm/.mov).
// Remote iframe embeds (YouTube, Vimeo) are still rendered via <iframe>.
function isDirectVideoSrc(src: string): boolean {
  return /\.(mp4|webm|mov|ogg)(\?.*)?$/i.test(src) || src.startsWith("/")
}

export function HeroVideoDialog({
  animationStyle = "from-center",
  videoSrc,
  thumbnailSrc,
  thumbnailAlt = "Video thumbnail",
  className,
  children,
}: HeroVideoProps) {
  const [isVideoOpen, setIsVideoOpen] = useState(false)
  const selectedAnimation = animationVariants[animationStyle]
  const useNativeVideo = isDirectVideoSrc(videoSrc)

  const openDialog = () => setIsVideoOpen(true)
  const closeDialog = () => setIsVideoOpen(false)
  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      openDialog()
    }
  }

  // Global ESC listener — needed because <video controls> steals focus,
  // so the backdrop's own onKeyDown never fires once playback starts.
  useEffect(() => {
    if (!isVideoOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsVideoOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isVideoOpen])

  return (
    <div className={cn("relative", className)}>
      {children ? (
        // Custom trigger (e.g. VideoText + play overlay). We use a div with
        // role="button" instead of a real <button> because consumers can nest
        // interactive content (`<video>`, `<iframe>`) inside the trigger, and
        // <button> cannot legally contain interactive descendants.
        <div
          role="button"
          tabIndex={0}
          aria-label="Play video"
          className="group relative block w-full cursor-pointer"
          onClick={openDialog}
          onKeyDown={handleTriggerKeyDown}
        >
          {children}
        </div>
      ) : (
        <button
          type="button"
          aria-label="Play video"
          className="group relative block w-full cursor-pointer border-0 bg-transparent p-0"
          onClick={openDialog}
        >
          {thumbnailSrc && (
            <img
              src={thumbnailSrc}
              alt={thumbnailAlt}
              width={1920}
              height={1080}
              className="w-full rounded-xl border border-border-default shadow-lg transition-all duration-200 ease-out group-hover:brightness-[0.8]"
            />
          )}
          <div className="absolute inset-0 flex scale-[0.9] items-center justify-center rounded-xl transition-all duration-200 ease-out group-hover:scale-100">
            <div className="flex size-24 items-center justify-center rounded-full border border-accent-border bg-bg-primary/40 backdrop-blur-md">
              <div
                className="relative flex size-16 scale-100 items-center justify-center rounded-full border border-accent-border bg-accent-muted transition-all duration-200 ease-out group-hover:scale-[1.15]"
              >
                <Play
                  className="ml-0.5 size-6 fill-accent-primary text-accent-primary transition-transform duration-200 ease-out group-hover:scale-105"
                />
              </div>
            </div>
          </div>
        </button>
      )}
      <AnimatePresence>
        {isVideoOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
                setIsVideoOpen(false)
              }
            }}
            onClick={() => setIsVideoOpen(false)}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md"
          >
            <motion.div
              {...selectedAnimation}
              transition={{ type: "spring", damping: 30, stiffness: 300 }}
              className="relative mx-4 aspect-video w-full max-w-6xl md:mx-0"
              onClick={(e) => e.stopPropagation()}
            >
              <motion.button
                type="button"
                aria-label="Close video"
                onClick={closeDialog}
                className="absolute top-3 right-3 z-20 flex size-10 items-center justify-center rounded-full border border-border-default bg-bg-primary/80 text-text-primary shadow-[var(--shadow-md)] backdrop-blur-md transition-colors hover:bg-bg-secondary hover:text-accent-primary"
              >
                <XIcon className="size-4" />
              </motion.button>
              <div className="relative isolate z-1 size-full overflow-hidden rounded-xl border border-border-default bg-bg-primary">
                {useNativeVideo ? (
                  <video
                    src={videoSrc}
                    className="size-full rounded-xl object-cover"
                    controls
                    autoPlay
                    playsInline
                  >
                    Your browser does not support the video tag.
                  </video>
                ) : (
                  <iframe
                    src={videoSrc}
                    title="Hero Video player"
                    className="mt-0 size-full rounded-xl"
                    allowFullScreen
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  ></iframe>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
