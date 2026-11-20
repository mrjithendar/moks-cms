import { redirect } from "next/navigation";

// Advanced settings no longer has a page: each group is on the page it configures (lib/runtime-settings.ts `page`):
// Integrations (Turnstile, verification, analytics and ads, image limits, video generation), Bookings (Cal.com),
// Payments (Razorpay), Storage (video destinations) and Users (members-only articles, profile pictures).
// Kept so old bookmarks land somewhere useful.
export default function AdvancedSettingsPage() {
  redirect("/admin/integrations");
}
