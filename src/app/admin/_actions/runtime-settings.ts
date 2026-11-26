"use server";

import { adminActor } from "@/lib/admin";
import { flash } from "@/lib/flash";
import { GROUPS, saveRuntimeGroup, settingHref } from "@/lib/runtime-settings";

/** Saves one runtime-settings group (components/admin/RuntimeSettings.tsx) and returns to its section of the Settings area. */
export async function saveRuntimeSettings(form: FormData) {
  const actor = await adminActor();
  const id = String(form.get("group") ?? "");
  const group = GROUPS.find((g) => g.id === id);
  await flash(group ? settingHref(group.id) : "/admin/settings", async () => {
    const input: Record<string, string> = {};
    for (const [k, v] of form.entries()) if (typeof v === "string" && /^[A-Z0-9_]+$/.test(k)) input[k] = v;
    const clear = form.getAll("clear").map(String);
    await saveRuntimeGroup(actor, id, input, clear);
    return `${group?.title ?? "Settings"} saved. Changes apply immediately.`;
  });
}
