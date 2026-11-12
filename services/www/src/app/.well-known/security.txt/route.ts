import { absoluteUrl } from "@/config/site";

// RFC 9116. Reports go through the contact form (no address published here that the owner has not chosen). Expires is
// always a year ahead, so the file never goes stale; the RFC asks for less than a year, hence 360 days.
export const revalidate = 86400;

export function GET() {
  const expires = new Date(Date.now() + 360 * 24 * 60 * 60 * 1000);
  expires.setUTCHours(0, 0, 0, 0);
  const body = [
    `Contact: ${absoluteUrl("/contact")}`,
    `Expires: ${expires.toISOString()}`,
    "Preferred-Languages: en",
    `Canonical: ${absoluteUrl("/.well-known/security.txt")}`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
}
