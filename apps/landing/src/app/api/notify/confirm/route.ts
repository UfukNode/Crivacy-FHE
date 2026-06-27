import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/notify/confirm?token=... — invoked by the link in the
// confirmation email. Looks up the row by token, sets confirmed_at,
// clears the token so the link can only be used once, then redirects
// to the success page. Any error path redirects to the same page with
// an `error` query so the UI can show a friendly message.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL || url.origin || "https://crivacy.io";

  if (!token) {
    return NextResponse.redirect(`${siteUrl}/waitlist-confirmed?error=missing`);
  }

  const { data: row, error: selectErr } = await supabaseAdmin
    .from("waitlist")
    .select("id, confirmed_at")
    .eq("confirmation_token", token)
    .maybeSingle();

  if (selectErr) {
    console.error("[confirm] select error", selectErr);
    return NextResponse.redirect(`${siteUrl}/waitlist-confirmed?error=server`);
  }

  if (!row) {
    return NextResponse.redirect(`${siteUrl}/waitlist-confirmed?error=invalid`);
  }

  if (row.confirmed_at) {
    // Already confirmed — still a success path.
    return NextResponse.redirect(`${siteUrl}/waitlist-confirmed`);
  }

  const { error: updErr } = await supabaseAdmin
    .from("waitlist")
    .update({
      confirmed_at: new Date().toISOString(),
      confirmation_token: null,
    })
    .eq("id", row.id);

  if (updErr) {
    console.error("[confirm] update error", updErr);
    return NextResponse.redirect(`${siteUrl}/waitlist-confirmed?error=server`);
  }

  return NextResponse.redirect(`${siteUrl}/waitlist-confirmed`);
}
