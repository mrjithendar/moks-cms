"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/form";

/** Track any keyword, also one the site has no Search Console impressions for yet (live ranks come from DataForSEO). */
export function TrackKeywordForm() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const q = query.trim().toLowerCase().replace(/\s+/g, " ");
        if (!q) return;
        setBusy(true);
        const res = await fetch("/api/admin/seo/keywords/actions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "track", query: q }) }).catch(() => null);
        setBusy(false);
        setMsg(res?.ok ? `Tracking “${q}”.` : "That did not work.");
        if (res?.ok) {
          setQuery("");
          router.refresh();
        }
      }}
    >
      <label className="grid gap-1 text-xs text-fg-subtle">
        Track a keyword
        <input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={200} placeholder="e.g. argo cd sync waves" className="min-h-11 w-64 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg md:min-h-9" />
      </label>
      <Button type="submit" size="sm" loading={busy}>Track</Button>
      {msg && <span role="status" className="text-xs text-fg-muted">{msg}</span>}
    </form>
  );
}
