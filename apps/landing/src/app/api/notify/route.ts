import { NextResponse } from "next/server";
import crypto from "node:crypto";

import { supabaseAdmin } from "@/lib/supabase";
import { waitlistRatelimit, hashIp } from "@/lib/rate-limit";
import { validateEmail } from "@/lib/email-validator";
import { sendConfirmation } from "@/lib/mail";

// Force the Node.js runtime — we need `nodemailer` (TCP) + `node:dns` +
// `node:crypto.randomBytes`, none of which work on the Edge runtime.
export const runtime = "nodejs";
// Fresh response every time — no CDN caching of a mutating endpoint.
export const dynamic = "force-dynamic";

const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type TurnstileResponse = {
  success: boolean;
  "error-codes"?: string[];
};

async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const body = new URLSearchParams({
    secret: process.env.TURNSTILE_SECRET_KEY!,
    response: token,
    remoteip: ip,
  });

  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body });
    const data = (await res.json()) as TurnstileResponse;
    return data.success === true;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  // Waitlist gate — flip SITE.waitlistActive to re-enable.
  // Returns 503 so clients know the service is temporarily unavailable.
  const { SITE } = await import("@/lib/site");
  if (!SITE.waitlistActive) {
    return NextResponse.json(
      { error: "Waitlist is currently closed." },
      { status: 503 },
    );
  }

  // Extract the client IP. Vercel/CF put the real IP in x-forwarded-for;
  // we take the first entry (chain is client, proxy1, proxy2, ...).
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const ip = xff.split(",")[0].trim() || "unknown";

  // 1. Rate limit — short-circuit BEFORE parsing the body so a flood
  //    can't cost us JSON parse CPU.
  const { success: rlOk } = await waitlistRatelimit.limit(ip);
  if (!rlOk) {
    return NextResponse.json(
      { error: "Too many requests. Please try again in a minute." },
      { status: 429 },
    );
  }

  // 2. Parse body
  let payload: { email?: string; token?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { email, token } = payload;
  if (!email || !token) {
    return NextResponse.json(
      { error: "Missing email or verification." },
      { status: 400 },
    );
  }

  // 3. Turnstile
  const captchaOk = await verifyTurnstile(token, ip);
  if (!captchaOk) {
    return NextResponse.json(
      { error: "Verification failed. Please try again." },
      { status: 403 },
    );
  }

  // 4. Email format + MX + disposable check
  const validation = await validateEmail(email);
  if (!validation.ok) {
    const messages: Record<typeof validation.reason, string> = {
      format: "Please enter a valid email address.",
      disposable: "Disposable email addresses are not allowed.",
      "no-mx": "This email domain doesn't accept mail.",
    };
    return NextResponse.json(
      { error: messages[validation.reason] },
      { status: 400 },
    );
  }

  const normalizedEmail = validation.email;
  const confirmationToken = crypto.randomBytes(32).toString("hex");
  const ipHash = await hashIp(ip);

  // 5. Idempotent upsert: check if the row exists first so we can handle
  //    the three branches explicitly (confirmed, pending, new).
  const { data: existing, error: selectErr } = await supabaseAdmin
    .from("waitlist")
    .select("id, confirmed_at")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (selectErr) {
    console.error("[notify] select error", selectErr);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }

  // Already confirmed → idempotent success, no need to resend.
  if (existing?.confirmed_at) {
    return NextResponse.json({
      ok: true,
      message: "You're already on the waitlist.",
    });
  }

  if (existing) {
    // Pending row: refresh the token so the old link expires implicitly.
    const { error: updErr } = await supabaseAdmin
      .from("waitlist")
      .update({ confirmation_token: confirmationToken, ip_hash: ipHash })
      .eq("id", existing.id);

    if (updErr) {
      console.error("[notify] update error", updErr);
      return NextResponse.json(
        { error: "Something went wrong. Please try again." },
        { status: 500 },
      );
    }
  } else {
    // Brand new row.
    const { error: insErr } = await supabaseAdmin.from("waitlist").insert({
      email: normalizedEmail,
      confirmation_token: confirmationToken,
      ip_hash: ipHash,
      source: "hero",
    });

    if (insErr) {
      console.error("[notify] insert error", insErr);
      return NextResponse.json(
        { error: "Something went wrong. Please try again." },
        { status: 500 },
      );
    }
  }

  // 6. Send confirmation mail. If SMTP fails we return an error so the
  //    user can retry — otherwise they'd have a pending row with no way
  //    to confirm it.
  try {
    await sendConfirmation(normalizedEmail, confirmationToken);
  } catch (err) {
    console.error("[notify] mail error", err);
    return NextResponse.json(
      { error: "Couldn't send confirmation email. Please try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: "Check your inbox to confirm your email.",
  });
}
