"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/form";

/** Accept / reject one pending internal-link change from the Internal Linking page (same API as the diff view). */
export function LinkDecision({ draftId, changeId, decision }: { draftId: string; changeId: string; decision: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function set(d: "accepted" | "rejected" | "pending") {
    setBusy(d);
    setError(null);
    const res = await fetch(`/api/admin/seo/drafts/${draftId}/changes/${changeId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: d }) }).catch(() => null);
    setBusy(null);
    if (!res?.ok) setError(((await res?.json().catch(() => ({}))) as { error?: string }).error ?? "Failed");
    else router.refresh();
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant={decision === "accepted" ? "primary" : "secondary"} aria-pressed={decision === "accepted"} loading={busy === "accepted"} onClick={() => set(decision === "accepted" ? "pending" : "accepted")}>{decision === "accepted" ? "✓ Accepted" : "Accept"}</Button>
      <Button size="sm" variant={decision === "rejected" ? "danger" : "secondary"} aria-pressed={decision === "rejected"} loading={busy === "rejected"} onClick={() => set(decision === "rejected" ? "pending" : "rejected")}>{decision === "rejected" ? "✕ Rejected" : "Reject"}</Button>
      {error && <span role="alert" className="text-xs text-red-700 dark:text-red-300">{error}</span>}
    </div>
  );
}
