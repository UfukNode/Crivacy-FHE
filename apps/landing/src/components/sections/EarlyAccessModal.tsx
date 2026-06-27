"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Loader2, Sparkles } from "lucide-react";

import { BorderBeam } from "@/components/ui/border-beam";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { WarpBackground } from "@/components/ui/warp-background";
import { SITE } from "@/lib/site";
import { useThemeColors } from "@/lib/use-theme-colors";
import { useTurnstile } from "@/lib/use-turnstile";

type ModalState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function EarlyAccessModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<ModalState>({ status: "idle" });
  const colors = useThemeColors();

  // Turnstile widget lives inside the dialog portal. We only enable it
  // when the dialog is open so Cloudflare doesn't mount an orphan widget
  // into a non-visible container.
  const turnstileRef = useRef<HTMLDivElement>(null);
  const { getToken } = useTurnstile(turnstileRef, { enabled: open });

  // Reset local state a moment after the dialog closes so the next open
  // starts fresh (no lingering success/error from a previous attempt).
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      setState({ status: "idle" });
      setEmail("");
    }, 220);
    return () => window.clearTimeout(timer);
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || state.status === "submitting") return;

    setState({ status: "submitting" });

    const token = await getToken();
    if (!token) {
      setState({
        status: "error",
        message: "Verification failed. Please try again.",
      });
      return;
    }

    try {
      const res = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), token }),
      });

      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };

      if (!res.ok || !data.ok) {
        setState({
          status: "error",
          message: data.error || "Something went wrong. Please try again.",
        });
        return;
      }

      setState({
        status: "success",
        message: data.message || "Check your inbox to confirm your email.",
      });
    } catch {
      setState({
        status: "error",
        message: "Network error. Please try again.",
      });
    }
  };

  const isSubmitting = state.status === "submitting";
  const showSuccess = state.status === "success";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* NOTE: do NOT add `relative` here — DialogContent's base class
          already provides `fixed top-1/2 left-1/2 -translate-*` for
          viewport centering, and tailwind-merge would otherwise drop
          the `fixed` and dump the modal at the bottom of the page.
          `fixed` is itself a positioning context, so BorderBeam's
          `absolute inset-0` child still anchors correctly. */}
      <DialogContent
        className="overflow-hidden border-border-default bg-bg-secondary p-0"
        style={{ maxWidth: "min(calc(100% - 2rem), 40rem)" }}
      >
        {/* Success state — WarpBackground + welcome message */}
        {showSuccess ? (
          <div className="relative">
            <WarpBackground
              className="border-0 bg-bg-secondary p-8"
              gridColor="var(--border-subtle)"
              beamsPerSide={3}
              beamDuration={3}
            >
              <div className="flex flex-col items-center gap-4 py-6 text-center">
                <div className="flex size-12 items-center justify-center rounded-full border border-accent-border bg-accent-muted text-accent-primary">
                  <Check className="size-6" />
                </div>
                <DialogTitle className="text-[22px] leading-tight font-semibold text-text-primary">
                  {SITE.earlyAccess.successTitle}
                </DialogTitle>
                <DialogDescription className="max-w-[22rem] text-[13px] leading-relaxed text-text-secondary">
                  {SITE.earlyAccess.successMessage}
                </DialogDescription>
                <div className="mt-1 inline-flex items-center gap-2 rounded-full border border-accent-border bg-accent-muted px-4 py-2 text-sm font-medium text-accent-primary sm:text-[15px]">
                  <Check className="size-4" strokeWidth={2.5} />
                  {state.message}
                </div>
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  className="mt-2 h-9 px-4 text-xs font-medium"
                >
                  Close
                </Button>
              </div>
            </WarpBackground>
          </div>
        ) : (
          // Form state — BorderBeam around the dialog content
          <div className="relative p-6">
            <DialogHeader className="gap-3">
              <div className="flex items-center gap-2 text-accent-primary">
                <Sparkles className="size-4" />
                <span className="font-mono text-[10px] tracking-[0.18em] uppercase">
                  Early Access
                </span>
              </div>
              <DialogTitle className="text-[22px] leading-tight font-semibold text-text-primary">
                {SITE.earlyAccess.modalTitle}
              </DialogTitle>
              <DialogDescription className="text-[13px] leading-relaxed text-text-secondary">
                {SITE.earlyAccess.modalDesc}
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-3">
              <Input
                type="email"
                autoFocus
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (state.status === "error") setState({ status: "idle" });
                }}
                placeholder={SITE.earlyAccess.emailPlaceholder}
                className="h-10 text-sm"
                disabled={isSubmitting}
                aria-invalid={state.status === "error"}
                aria-describedby={
                  state.status === "error" ? "early-access-error" : undefined
                }
              />
              {state.status === "error" && (
                <p
                  id="early-access-error"
                  className="text-[12px] text-state-error"
                >
                  {state.message}
                </p>
              )}
              <Button
                type="submit"
                disabled={isSubmitting}
                className="h-10 w-full text-sm font-medium"
              >
                {isSubmitting ? (
                  <>
                    <Loader2
                      className="mr-1.5 size-3.5 animate-spin"
                      style={{ willChange: "transform" }}
                    />
                    Sending
                  </>
                ) : (
                  <>
                    {SITE.earlyAccess.submit}
                    <ArrowRight className="ml-1.5 size-3.5" />
                  </>
                )}
              </Button>

              {/* Invisible Turnstile container — same pattern as Hero form. */}
              <div ref={turnstileRef} aria-hidden="true" />

              <p className="mt-1 text-center font-mono text-[10px] tracking-wide text-text-tertiary">
                Your email is only used to notify you when Crivacy launches.
              </p>
            </form>

            <BorderBeam
              duration={7}
              size={200}
              colorFrom={colors.accentPrimary}
              colorTo={colors.accentHover}
              borderWidth={1.2}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
