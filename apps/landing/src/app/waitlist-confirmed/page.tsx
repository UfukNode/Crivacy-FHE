"use client";

// Waitlist confirmation landing. Rendered at /waitlist-confirmed after
// the user clicks the link in the confirmation email. The API route
// redirects here with an optional `?error=...` param on the failure
// paths (missing/invalid/server) so we can show a friendly message
// without exposing the real reason.
//
// Both variants share the same borderless, full-viewport layout —
// a WebGL backdrop + a centered stack (pill · headline · subtitle ·
// Return home). Only the shader, tint and copy differ.
//
//   - Success — GridScan (accent-green scan over a subtle grid)
//   - Error   — FaultyTerminal (red #b81425 glitch shader)
//
// Both backdrops are lazy-loaded with `ssr: false` because they read
// `window` during construction, which would crash the prerender step.

import Link from "next/link";
import { Suspense } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, CheckCircle2 } from "lucide-react";

import { ShineBorder } from "@/components/ui/shine-border";
import { SITE } from "@/lib/site";

// Lazy, client-only — both shaders touch `window` at construction.
const FaultyTerminal = dynamic(
  () => import("@/components/react-bits/FaultyTerminal"),
  { ssr: false },
);
const GridScan = dynamic(
  () => import("@/components/react-bits/GridScan"),
  { ssr: false },
);

// Local tints — kept here (not in tokens.css) because each is tied to a
// specific shader and doesn't belong to the global palette.
const ERROR_TINT = "#b81425";
// Matches --accent-primary from tokens.css. Used for the GridScan scan
// beam and the Return home ShineBorder gradient on the success view.
const ACCENT_TINT = "#63dcbe";

function ErrorView({ subtitle }: { subtitle: string }) {
  return (
    <main className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden bg-bg-primary px-6 py-16">
      {/* FaultyTerminal fills the viewport. Container keeps pointer
          events so `mouseReact` can distort the shader toward the
          cursor. The content wrapper below is `pointer-events-none`
          (only the Return home link opts back in), so clicks pass
          through to the shader everywhere except the CTA. */}
      <div className="absolute inset-0">
        <FaultyTerminal
          tint={ERROR_TINT}
          scale={3}
          gridMul={[2, 1]}
          digitSize={1.4}
          timeScale={0.35}
          scanlineIntensity={0.45}
          glitchAmount={1.2}
          flickerAmount={1.1}
          noiseAmp={1}
          chromaticAberration={0}
          curvature={0.15}
          mouseReact
          mouseStrength={0.25}
          brightness={0.9}
          className="size-full"
        />
      </div>

      {/* Content — no card, but each text element gets its own small
          borderless dark backdrop (box-decoration-break so wrapped
          lines stay inside the highlight) so white text lifts off the
          red noise without fighting it. Wrapper is pointer-events-none
          so mousemove reaches the shader; only Return home opts back in. */}
      <div className="pointer-events-none relative z-10 flex w-full max-w-6xl flex-col items-center gap-8 text-center sm:gap-10">
        <div
          className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 font-mono text-[12px] tracking-[0.2em] uppercase shadow-lg"
          style={{
            backgroundColor: "rgba(255, 255, 255, 0.92)",
            color: ERROR_TINT,
          }}
        >
          <span
            className="size-1.5 animate-pulse rounded-full"
            style={{ backgroundColor: ERROR_TINT }}
          />
          Signal Lost
        </div>

        <p
          className="max-w-4xl font-display font-semibold tracking-tight"
          style={{
            fontSize: "clamp(1rem, 2.2vw, 2rem)",
            lineHeight: 1.3,
            color: "var(--text-primary)",
          }}
        >
          <span className="inline-block rounded-md bg-bg-primary/80 px-4 py-2 backdrop-blur-sm sm:px-6 sm:py-3">
            {subtitle}
          </span>
        </p>

        <Link
          href="/"
          className="group pointer-events-auto relative mt-2 inline-flex h-11 items-center gap-2 overflow-hidden rounded-lg border border-border-default bg-bg-secondary/60 px-5 text-sm font-medium text-text-primary backdrop-blur-sm transition-colors hover:bg-bg-secondary/80 sm:h-12 sm:px-6 sm:text-[15px]"
        >
          <ShineBorder
            borderWidth={1.2}
            duration={8}
            shineColor={["#ffffff", ERROR_TINT, "#ffffff"]}
          />
          <ArrowLeft className="size-4 shrink-0 transition-transform group-hover:-translate-x-0.5" />
          Return home
        </Link>
      </div>
    </main>
  );
}

function SuccessView() {
  return (
    <main className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden bg-bg-primary px-6 py-16">
      {/* GridScan — animated grid shader from react-bits with the
          Crivacy accent-green sweeping across subtle dark grid lines.
          Face-tracking code path was stripped from the upstream
          component; only mouse parallax remains. Container keeps
          pointer events so the look-target can follow the cursor;
          the content stack below is `pointer-events-none`. */}
      <div className="absolute inset-0">
        <GridScan
          linesColor="#2a2a38"
          scanColor={ACCENT_TINT}
          scanOpacity={0.6}
          gridScale={0.12}
          lineThickness={1}
          lineJitter={0.05}
          scanDirection="pingpong"
          scanDuration={2.4}
          scanDelay={1.2}
          scanGlow={0.7}
          scanSoftness={2}
          scanPhaseTaper={0.9}
          noiseIntensity={0.008}
          enablePost
          bloomIntensity={0}
          chromaticAberration={0.0012}
          sensitivity={0.45}
          className="size-full"
        />
      </div>

      {/* Content stack — mirrors ErrorView exactly so both variants
          share rhythm, spacing and responsive behavior. Only the
          pill color, the headline weight, and the ShineBorder palette
          differ. */}
      <div className="pointer-events-none relative z-10 flex w-full max-w-6xl flex-col items-center gap-8 text-center sm:gap-10">
        {/* Signed In Private — same dimensions as Signal Lost
            (px-4 py-1.5, text-[12px], tracking-[0.2em]) but keeps
            the accent-green palette and the check icon. */}
        <div
          className="inline-flex items-center gap-2 rounded-full border border-accent-border bg-accent-muted px-4 py-1.5 font-mono text-[12px] tracking-[0.2em] uppercase shadow-lg"
          style={{ color: ACCENT_TINT }}
        >
          <CheckCircle2 className="size-3.5" strokeWidth={2.5} />
          Signed In Private
        </div>

        {/* "Welcome to the inner circle." — bold display headline.
            Same backdrop treatment as the error subtitle so the
            white text stays readable over the animated grid. */}
        <h1
          className="font-display font-bold tracking-tight"
          style={{
            fontSize: "clamp(1.75rem, 4.5vw, 3.5rem)",
            lineHeight: 1.1,
            color: "var(--text-primary)",
          }}
        >
          <span className="inline-block rounded-md bg-bg-primary/80 px-4 py-2 backdrop-blur-sm sm:px-6 sm:py-3">
            {SITE.earlyAccess.successTitle}
          </span>
        </h1>

        {/* Success message — normal weight, same clamp + backdrop
            treatment as the error subtitle for visual parity. */}
        <p
          className="max-w-4xl font-display font-normal tracking-tight"
          style={{
            fontSize: "clamp(1rem, 2.2vw, 2rem)",
            lineHeight: 1.3,
            color: "var(--text-primary)",
          }}
        >
          <span className="inline-block rounded-md bg-bg-primary/80 px-4 py-2 backdrop-blur-sm sm:px-6 sm:py-3">
            {SITE.earlyAccess.successMessage}
          </span>
        </p>

        {/* Return home — identical geometry to the error variant,
            only the ShineBorder palette swaps red for accent-green. */}
        <Link
          href="/"
          className="group pointer-events-auto relative mt-2 inline-flex h-11 items-center gap-2 overflow-hidden rounded-lg border border-border-default bg-bg-secondary/60 px-5 text-sm font-medium text-text-primary backdrop-blur-sm transition-colors hover:bg-bg-secondary/80 sm:h-12 sm:px-6 sm:text-[15px]"
        >
          <ShineBorder
            borderWidth={1.2}
            duration={8}
            shineColor={["#ffffff", ACCENT_TINT, "#ffffff"]}
          />
          <ArrowLeft className="size-4 shrink-0 transition-transform group-hover:-translate-x-0.5" />
          Return home
        </Link>
      </div>
    </main>
  );
}

function ConfirmedContent() {
  const params = useSearchParams();
  const error = params.get("error");

  if (error !== null) {
    const subtitle =
      error === "invalid"
        ? "This confirmation link is invalid or has already been used. Request a new one from the early access form."
        : error === "missing"
          ? "This confirmation link is incomplete. Open the original email and click the button again."
          : "Something went wrong on our side. Please try again in a moment.";

    return <ErrorView subtitle={subtitle} />;
  }

  return <SuccessView />;
}

export default function WaitlistConfirmedPage() {
  // useSearchParams requires a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <ConfirmedContent />
    </Suspense>
  );
}
