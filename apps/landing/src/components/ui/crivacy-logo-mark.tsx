import type { SVGProps } from "react";

/**
 * Crivacy symbol-only mark (no wordmark). Uses `currentColor` so the
 * parent's `color` CSS property controls the fill — lets us theme-swap
 * dark/white with a single file.
 *
 * Shape comes from `Crivacy-Components/Logos SVG/Asset 24.svg` (the
 * #121212 variant) — Asset 26 (#e4e4e4 white) and Asset 25 (#f5ff99
 * yellow) share the exact same paths, only fill differs.
 */
export function CrivacyLogoMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 400 337.42"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M32.13,181.09c13.94,8.33,27.89,16.66,41.83,25-1.46,2.64-3.28,6.37-4.77,11.05,0,0-1.53,5.74-2.42,11.01-1.19,7.08-.31,23.9,12.35,35.89,11.65,11.04,28.46,13.44,39.64,9.56,7.45-2.59,14.15-6.81,16-8.17,4.52-3.34,7.76-6.82,9.91-9.45,3,4.34,7.17,11.58,9.21,21.39,1.28,6.13,1.37,11.53,1.1,15.65-15.7,12.62-31.4,25.24-47.1,37.86l-93.74-61.96,18-87.83Z" />
      <path d="M365.78,181.09c-13.94,8.33-27.89,16.66-41.83,25,1.46,2.64,3.28,6.37,4.77,11.05,0,0,1.53,5.74,2.42,11.01,1.19,7.08.31,23.9-12.35,35.89-11.65,11.04-28.46,13.44-39.64,9.56-7.45-2.59-14.15-6.81-16-8.17-4.52-3.34-7.76-6.82-9.91-9.45-3,4.34-7.17,11.58-9.21,21.39-1.28,6.13-1.37,11.53-1.1,15.65,15.7,12.62,31.4,25.24,47.1,37.86l93.74-61.96-18-87.83Z" />
      <polygon points="400 57.03 391.74 138.09 236.5 240.68 200 337.42 163.5 240.68 8.26 138.09 0 57.03 85.3 120.83 175.29 99.33 200 0 224.71 99.33 314.7 120.83 400 57.03" />
    </svg>
  );
}
