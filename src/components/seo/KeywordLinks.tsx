"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Keyword = { id: string; keyword: string; url: string; caseSensitive: boolean; enabled: boolean };

/** The keyword → URL list: add, enable/disable, delete. The server checks site paths exist and are indexable. */
export function KeywordLinks({ initial }: { initial: Keyword[] }) {
  const router = useRouter();
  const [keyword, setKeyword] = useState("");
  const [url, setUrl] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const send = async (path: string, method: string, body?: unknown) => {
    setMsg(null);
    const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[] };
    if (!res.ok) {
      setMsg([data.error, ...(data.issues ?? [])].filter(Boolean).join(" "));
      return false;
    }
    router.refresh();
    return true;
  };
  const input = "min-h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg";
  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await send("/api/admin/seo/link-keywords", "POST", { keyword, url, caseSensitive })) {
            setKeyword("");
            setUrl("");
            setCaseSensitive(false);
          }
        }}
      >
        <label className="grid gap-1 text-xs text-fg-subtle">Keyword<input required minLength={2} maxLength={80} className={input} value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="GitOps" /></label>
        <label className="grid min-w-[min(16rem,100%)] flex-1 gap-1 text-xs text-fg-subtle">Links to<input required className={`${input} w-full`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="/blog/gitops-guide or https://…" /></label>
        <label className="flex min-h-9 items-center gap-1.5 text-xs text-fg-muted"><input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> Match case</label>
        <button type="submit" className="min-h-9 rounded-md bg-accent px-3 text-sm font-medium text-on-accent">Add</button>
      </form>
      {msg && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{msg}</p>}
      {initial.length ? (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {initial.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className={`font-medium ${k.enabled ? "text-fg" : "text-fg-subtle line-through"}`}>{k.keyword}</span>
              <span className="text-fg-subtle">→</span>
              <span className="min-w-0 flex-1 break-all font-mono text-xs text-fg-muted">{k.url}{k.url.startsWith("https://") ? " (nofollow)" : ""}</span>
              {k.caseSensitive && <span className="text-xs text-fg-subtle">match case</span>}
              <button type="button" className="min-h-8 rounded-md border border-line-strong px-2 text-xs" onClick={() => void send(`/api/admin/seo/link-keywords/${k.id}`, "PATCH", { enabled: !k.enabled })}>{k.enabled ? "Disable" : "Enable"}</button>
              <button type="button" className="min-h-8 rounded-md border border-line-strong px-2 text-xs" onClick={() => window.confirm(`Remove “${k.keyword}”? Links already published stay.`) && void send(`/api/admin/seo/link-keywords/${k.id}`, "DELETE")}>Remove</button>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-fg-subtle">No keywords yet. Add one: its first mention in each article is linked (within the usual limits).</p>}
    </div>
  );
}
