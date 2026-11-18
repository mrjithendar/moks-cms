"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/form";

/** Add a prompt to ask AI assistants every week (AI visibility). */
export function AddPromptForm() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const p = prompt.trim();
        if (p.length < 5) return setMsg("Write a question of at least 5 characters.");
        setBusy(true);
        const res = await fetch("/api/admin/seo/ai-visibility", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", prompt: p }) }).catch(() => null);
        const data = (await res?.json().catch(() => ({}))) as { added?: boolean; error?: string };
        setBusy(false);
        setMsg(!res?.ok ? (data.error ?? "That did not work.") : data.added ? "Added." : "That prompt is already tracked.");
        if (res?.ok) {
          setPrompt("");
          router.refresh();
        }
      }}
    >
      <label className="grid flex-1 gap-1 text-xs text-fg-subtle">
        Add a prompt (a question a reader would ask an assistant)
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={200} placeholder="e.g. How do Argo CD sync waves work?" className="min-h-11 w-full min-w-[min(16rem,100%)] rounded-md border border-line-strong bg-surface px-2 text-sm text-fg md:min-h-9" />
      </label>
      <Button type="submit" size="sm" loading={busy}>Add</Button>
      {msg && <span role="status" className="text-xs text-fg-muted">{msg}</span>}
    </form>
  );
}
