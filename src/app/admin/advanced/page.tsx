import { redirect } from "next/navigation";
import { SETTINGS_PATH } from "@/lib/settings-areas";

// Advanced settings no longer has a page: every group is a section of the Settings area (lib/settings-areas.ts).
// Kept so old bookmarks land somewhere useful.
export default function AdvancedSettingsPage() {
  redirect(SETTINGS_PATH);
}
