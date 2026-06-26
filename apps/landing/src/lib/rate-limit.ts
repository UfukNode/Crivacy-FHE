import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

// Upstash Redis REST client. Reads URL + token from env — both must be set
// at build time or the API route throws on first request.
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// 3 requests per 60 seconds per key (IP). Chosen to cover the legitimate
// "typo + retry" case without letting a single IP hammer the endpoint.
// Sliding window gives smoother behaviour than fixed window at boundary
// moments.
export const waitlistRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, "60 s"),
  analytics: true,
  prefix: "ratelimit:waitlist",
});

export async function hashIp(ip: string): Promise<string> {
  // SHA-256 via Web Crypto (available in Node 20+ and Edge runtime).
  // We only need a stable opaque key for dedup / analytics — no need
  // to salt it.
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
