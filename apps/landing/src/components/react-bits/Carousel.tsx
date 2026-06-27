"use client";

// Image-first adaptation of the react-bits Carousel component.
// Original: https://reactbits.dev/components/carousel
// Adapted for Crivacy: screenshot-focused items, token colors, no react-icons.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import {
  motion,
  useMotionValue,
  useTransform,
  type PanInfo,
} from "motion/react";

export interface CarouselItem {
  id: number;
  image: string;
  title: string;
  caption: string;
  alt?: string;
}

export interface CarouselProps {
  items: readonly CarouselItem[];
  baseWidth?: number;
  baseHeight?: number;
  autoplay?: boolean;
  autoplayDelay?: number;
  pauseOnHover?: boolean;
  loop?: boolean;
}

const DRAG_BUFFER = 0;
const VELOCITY_THRESHOLD = 500;
const GAP = 16;
const SPRING_OPTIONS = {
  type: "spring" as const,
  stiffness: 300,
  damping: 30,
};

interface CarouselSlideProps {
  item: CarouselItem;
  index: number;
  itemWidth: number;
  itemHeight: number;
  trackItemOffset: number;
  // motion value; typed loosely to match upstream signature
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  x: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transition: any;
}

function CarouselSlide({
  item,
  index,
  itemWidth,
  itemHeight,
  trackItemOffset,
  x,
  transition,
}: CarouselSlideProps) {
  const range = [
    -(index + 1) * trackItemOffset,
    -index * trackItemOffset,
    -(index - 1) * trackItemOffset,
  ];
  const outputRange = [75, 0, -75];
  const rotateY = useTransform(x, range, outputRange, { clamp: false });

  return (
    <motion.div
      className="relative shrink-0 overflow-hidden rounded-xl border border-border-subtle bg-bg-secondary cursor-grab active:cursor-grabbing"
      style={{
        width: itemWidth,
        height: itemHeight,
        rotateY,
      }}
      transition={transition}
    >
      {/* Screenshot */}
      <img
        src={item.image}
        alt={item.alt ?? item.title}
        draggable={false}
        className="absolute inset-0 h-full w-full object-cover select-none pointer-events-none"
      />

      {/* Subtle dark gradient for legibility */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-32"
        style={{
          background:
            "linear-gradient(to top, color-mix(in srgb, var(--bg-primary) 85%, transparent), color-mix(in srgb, var(--bg-primary) 0%, transparent))",
        }}
      />

      {/* Caption */}
      <div className="absolute inset-x-0 bottom-0 p-5">
        <div className="font-mono text-[10px] tracking-[0.16em] text-accent-primary uppercase">
          {item.title}
        </div>
        <p className="mt-1 text-[13px] leading-snug text-text-primary">
          {item.caption}
        </p>
      </div>
    </motion.div>
  );
}

export default function Carousel({
  items,
  baseWidth = 560,
  baseHeight = 360,
  autoplay = false,
  autoplayDelay = 3000,
  pauseOnHover = false,
  loop = false,
}: CarouselProps): JSX.Element {
  const containerPadding = 16;
  const itemWidth = baseWidth - containerPadding * 2;
  const itemHeight = baseHeight - containerPadding * 2;
  const trackItemOffset = itemWidth + GAP;

  const itemsForRender = useMemo(() => {
    if (!loop) return items;
    if (items.length === 0) return [];
    return [items[items.length - 1], ...items, items[0]];
  }, [items, loop]);

  const [position, setPosition] = useState<number>(loop ? 1 : 0);
  const x = useMotionValue(0);
  const [isHovered, setIsHovered] = useState<boolean>(false);
  const [isJumping, setIsJumping] = useState<boolean>(false);
  const [isAnimating, setIsAnimating] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pauseOnHover || !containerRef.current) return;
    const container = containerRef.current;
    const handleMouseEnter = () => setIsHovered(true);
    const handleMouseLeave = () => setIsHovered(false);
    container.addEventListener("mouseenter", handleMouseEnter);
    container.addEventListener("mouseleave", handleMouseLeave);
    return () => {
      container.removeEventListener("mouseenter", handleMouseEnter);
      container.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [pauseOnHover]);

  useEffect(() => {
    if (!autoplay || itemsForRender.length <= 1) return undefined;
    if (pauseOnHover && isHovered) return undefined;

    const timer = setInterval(() => {
      setPosition((prev) =>
        Math.min(prev + 1, itemsForRender.length - 1),
      );
    }, autoplayDelay);

    return () => clearInterval(timer);
  }, [
    autoplay,
    autoplayDelay,
    isHovered,
    pauseOnHover,
    itemsForRender.length,
  ]);

  useEffect(() => {
    const startingPosition = loop ? 1 : 0;
    setPosition(startingPosition);
    x.set(-startingPosition * trackItemOffset);
  }, [items.length, loop, trackItemOffset, x]);

  useEffect(() => {
    if (!loop && position > itemsForRender.length - 1) {
      setPosition(Math.max(0, itemsForRender.length - 1));
    }
  }, [itemsForRender.length, loop, position]);

  const effectiveTransition = isJumping
    ? { duration: 0 }
    : SPRING_OPTIONS;

  const handleAnimationStart = () => {
    setIsAnimating(true);
  };

  const handleAnimationComplete = () => {
    if (!loop || itemsForRender.length <= 1) {
      setIsAnimating(false);
      return;
    }
    const lastCloneIndex = itemsForRender.length - 1;

    if (position === lastCloneIndex) {
      setIsJumping(true);
      const target = 1;
      setPosition(target);
      x.set(-target * trackItemOffset);
      requestAnimationFrame(() => {
        setIsJumping(false);
        setIsAnimating(false);
      });
      return;
    }

    if (position === 0) {
      setIsJumping(true);
      const target = items.length;
      setPosition(target);
      x.set(-target * trackItemOffset);
      requestAnimationFrame(() => {
        setIsJumping(false);
        setIsAnimating(false);
      });
      return;
    }

    setIsAnimating(false);
  };

  const handleDragEnd = (
    _: MouseEvent | TouchEvent | PointerEvent,
    info: PanInfo,
  ): void => {
    const { offset, velocity } = info;
    const direction =
      offset.x < -DRAG_BUFFER || velocity.x < -VELOCITY_THRESHOLD
        ? 1
        : offset.x > DRAG_BUFFER || velocity.x > VELOCITY_THRESHOLD
          ? -1
          : 0;

    if (direction === 0) return;

    setPosition((prev) => {
      const next = prev + direction;
      const max = itemsForRender.length - 1;
      return Math.max(0, Math.min(next, max));
    });
  };

  const dragProps = loop
    ? {}
    : {
        dragConstraints: {
          left: -trackItemOffset * Math.max(itemsForRender.length - 1, 0),
          right: 0,
        },
      };

  const activeIndex =
    items.length === 0
      ? 0
      : loop
        ? (position - 1 + items.length) % items.length
        : Math.min(position, items.length - 1);

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden rounded-2xl border border-border-subtle bg-bg-secondary/40 p-4 backdrop-blur-sm"
      style={{
        width: `${baseWidth}px`,
        maxWidth: "100%",
      }}
    >
      <motion.div
        className="flex"
        drag={isAnimating ? false : "x"}
        {...dragProps}
        style={{
          width: itemWidth,
          gap: `${GAP}px`,
          perspective: 1000,
          perspectiveOrigin: `${position * trackItemOffset + itemWidth / 2}px 50%`,
          x,
        }}
        onDragEnd={handleDragEnd}
        animate={{ x: -(position * trackItemOffset) }}
        transition={effectiveTransition}
        onAnimationStart={handleAnimationStart}
        onAnimationComplete={handleAnimationComplete}
      >
        {itemsForRender.map((item, index) => (
          <CarouselSlide
            key={`${item?.id ?? index}-${index}`}
            item={item}
            index={index}
            itemWidth={itemWidth}
            itemHeight={itemHeight}
            trackItemOffset={trackItemOffset}
            x={x}
            transition={effectiveTransition}
          />
        ))}
      </motion.div>

      {/* Indicator dots */}
      <div className="mt-4 flex w-full justify-center">
        <div className="flex items-center gap-2">
          {items.map((_, index) => (
            <motion.button
              type="button"
              key={index}
              aria-label={`Go to slide ${index + 1}`}
              className={`h-1.5 rounded-full transition-colors duration-200 ${
                activeIndex === index
                  ? "w-6 bg-accent-primary"
                  : "w-1.5 bg-text-tertiary/40 hover:bg-text-tertiary"
              }`}
              animate={{
                scale: activeIndex === index ? 1 : 1,
              }}
              onClick={() => setPosition(loop ? index + 1 : index)}
              transition={{ duration: 0.15 }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
