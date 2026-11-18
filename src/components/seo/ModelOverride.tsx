"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** auto / force rule / force model for one model kind (PUT /api/admin/seo/models/{kind}). */
export function ModelOverride({ kind, value }: { kind: string; value: "auto" | "rule" | "model" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <label className="inline-flex items-center gap-2 text-sm text-fg-muted">
      Use
      <select
        className="min-h-8 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg"
        value={value}
        disabled={busy}
        aria-label={`Override for ${kind}`}
        onChange={async (e) => {
          setBusy(true);
          setErr(null);
          const res = await fetch(`/api/admin/seo/models/${kind}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ override: e.target.value }) }).catch(() => null);
          setBusy(false);
          if (!res?.ok) setErr("Could not save.");
          else router.refresh();
        }}
      >
        <option value="auto">auto (activation rule)</option>
        <option value="rule">force the rule</option>
        <option value="model">force the model</option>
      </select>
      {err && <span className="text-xs text-red-700 dark:text-red-300">{err}</span>}
    </label>
  );
}
