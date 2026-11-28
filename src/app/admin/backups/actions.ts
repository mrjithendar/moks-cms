"use server";

import { actorOf } from "@/lib/admin";
import { cancelOperation, deleteBackup, requestBackup, requestRestore, requestVerify } from "@/lib/backup/service";
import { DEMO_READ_ONLY_MESSAGE } from "@/lib/demo";
import { flash } from "@/lib/flash";
import { PostError } from "@/lib/posts";
import { requireRole } from "@/lib/session";

/** Admin → Backups actions. Every one is an admin's (never a demo account's) and is audited by lib/backup/service.ts. */
async function backupAdmin() {
  const user = await requireRole("admin");
  if (user.demo) throw new PostError(DEMO_READ_ONLY_MESSAGE, 403);
  return actorOf(user);
}

const back = (name?: string) => (name ? `/admin/backups/${encodeURIComponent(name)}` : "/admin/backups");

export async function createBackupAction(form: FormData) {
  await flash("/admin/backups", async () => {
    const actor = await backupAdmin();
    const type = form.get("type") === "database" ? "database" : "full";
    await requestBackup(type, "manual", { actor, label: actor.label });
    return `${type === "full" ? "Full site" : "Database"} backup queued. It runs in the background and starts within 15 seconds; this page shows its progress.`;
  });
}

export async function verifyBackupAction(form: FormData) {
  const name = String(form.get("name") ?? "");
  await flash(back(name), async () => {
    await requestVerify(await backupAdmin(), name);
    return "Verification queued: every file of the archive is read back and checked against its checksum.";
  });
}

export async function deleteBackupAction(form: FormData) {
  const name = String(form.get("name") ?? "");
  await flash("/admin/backups", async () => {
    await deleteBackup(await backupAdmin(), name);
    return `Deleted ${name}.`;
  });
}

export async function cancelOperationAction(form: FormData) {
  await flash("/admin/backups", async () => {
    const r = await cancelOperation(await backupAdmin(), String(form.get("id") ?? ""));
    return r === "cancelled" ? "Cancelled before it started." : "Asked to stop: it stops at its next step (a restore only before it changes anything).";
  });
}

/** A refused restore comes back to its form (with the reason); a queued one goes to Admin → Backups, which shows its progress. */
export async function restoreBackupAction(form: FormData) {
  const name = String(form.get("name") ?? "");
  let refused: unknown = null;
  try {
    await requestRestore(await backupAdmin(), name, {
      components: { database: form.has("database"), uploads: form.has("uploads") },
      allowUnsigned: form.get("allowUnsigned") === "on",
      confirmation: String(form.get("confirmation") ?? ""),
    });
  } catch (error) {
    refused = error;
  }
  if (refused) {
    await flash(`${back(name)}/restore`, async () => {
      throw refused;
    });
  }
  await flash("/admin/backups", async () => "Restore queued. It verifies the archive, backs up the current database first, then restores.");
}
