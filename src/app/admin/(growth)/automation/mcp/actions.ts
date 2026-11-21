"use server";

import { revalidatePath } from "next/cache";
import { adminActor } from "@/lib/admin";
import { auditSafe } from "@/lib/audit";
import { revokeGrantById } from "@/lib/mcp-oauth/oauth";

/** Revoke one connected client: its grant and every access/refresh token issued under it, effective immediately. */
export async function revokeGrant(formData: FormData) {
  const actor = await adminActor();
  const id = String(formData.get("grantId") ?? "");
  await revokeGrantById(id);
  await auditSafe(actor, "seo.mcp.grant_revoked", id, {}, { severity: "warning" });
  revalidatePath("/admin/automation");
}
