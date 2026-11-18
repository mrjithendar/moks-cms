import { createHmac } from "node:crypto";

/**
 * Ask the Blog privacy: the raw IP never leaves the web app. The agent gets an HMAC of the IP with a daily-rotating
 * key derived from BETTER_AUTH_SECRET (so hashes cannot be joined across days or recomputed without the secret);
 * the log keeps it ASK_BLOG_RETENTION_DAYS. Rate limiting uses the existing limiter on the raw IP, in memory/DB rows
 * that expire with their window.
 */
export function ipHash(ip: string | null, now = new Date(), secret = process.env.BETTER_AUTH_SECRET ?? ""): string | null {
  if (!ip || !secret) return null;
  const day = now.toISOString().slice(0, 10);
  const key = createHmac("sha256", secret).update(`ask-blog:${day}`).digest();
  return createHmac("sha256", key).update(ip).digest("hex").slice(0, 32);
}

export const ASK_LIMITS = { perMinute: 6, perDay: 60, maxQuestion: 500 };
