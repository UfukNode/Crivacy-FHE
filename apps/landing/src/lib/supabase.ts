import { createClient } from "@supabase/supabase-js";

// Server-side Supabase client. Uses the service role key, which bypasses
// RLS — so this module MUST only be imported from server code (API routes,
// server components, etc). Never import it from a "use client" file.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabaseAdmin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export type WaitlistRow = {
  id: string;
  email: string;
  confirmation_token: string | null;
  confirmed_at: string | null;
  created_at: string;
  ip_hash: string | null;
  source: string | null;
};
