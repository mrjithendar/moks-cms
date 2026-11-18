"use server";

import { redirect } from "next/navigation";
import { auditSafe } from "@/lib/audit";
import { approve, denyUrl, parseAuthorize } from "@/lib/mcp-oauth/oauth";
import { adminMcpEnabled } from "@/lib/seo-agent/config";
import { getSessionUser } from "@/lib/session";

/**
 * Consent decision. The request is re-validated from the original query (never trusted from hidden fields alone),
 * the user must still be an admin, and Next's server-action origin check applies (CSRF).
 */
export async function decide(formData: FormData) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin" || !adminMcpEnabled()) redirect("/account?denied=1");
  const q = Object.fromEntries([...formData.entries()].filter(([k]) => k.startsWith("q_")).map(([k, v]) => [k.slice(2), String(v)]));
  const r = await parseAuthorize(q);
  if (!("ok" in r)) redirect("/account?denied=1");
  if (formData.get("decision") !== "allow") {
    await auditSafe({ id: user.id, label: user.email }, "seo.mcp.consent_denied", r.ok.clientId, { client: r.ok.clientName });
    redirect(denyUrl(r.ok));
  }
  const url = await approve(r.ok, user.id);
  await auditSafe({ id: user.id, label: user.email }, "seo.mcp.consent_granted", r.ok.clientId, { client: r.ok.clientName, scopes: r.ok.scopes, redirectHost: new URL(r.ok.redirectUri).host }, { severity: "warning" });
  redirect(url);
}
