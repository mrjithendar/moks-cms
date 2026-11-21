"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, StatusPill } from "@/components/admin/ui";
import { Alert, Button, Field, Input } from "@/components/ui/form";
import type { NewsAgentStatus } from "@/lib/news-agent/endpoint";

const SOURCE: Record<string, string> = { env: "NEWS_AGENT_URL", admin: "saved here", discovered: "discovered" };

/**
 * Newsroom → Settings → "News agent": whether the service that runs the news desk (mrjithendar/newsroom, image
 * news-agent) is found, where and why, and the endpoint an admin can add when discovery does not find it
 * (PUT /api/admin/news/agent; audit-logged). Without it the Newsroom still opens; nothing runs.
 */
export function NewsAgentCard({ initial }: { initial: NewsAgentStatus }) {
  const router = useRouter();
  const [st, setSt] = useState(initial);
  const [url, setUrl] = useState(initial.adminUrl ?? "");
  const [busy, setBusy] = useState<"save" | "remove" | "check" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: string[] } | null>(null);
  const locked = Boolean(st.envUrl);

  async function send(kind: "save" | "remove" | "check") {
    setBusy(kind);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/news/agent", {
        method: kind === "check" ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: kind === "check" ? undefined : JSON.stringify({ url: kind === "remove" ? null : url }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; reference?: string; status?: NewsAgentStatus };
      if (!res.ok || !data.status) {
        setMsg({ ok: false, text: (data.error ?? `HTTP ${res.status}`) + (data.reference ? ` (ref ${data.reference})` : ""), issues: data.issues });
        return;
      }
      setSt(data.status);
      setUrl(data.status.adminUrl ?? "");
      const text = kind === "check" ? "Checked." : kind === "remove" ? "Removed. Back to discovery." : "Saved.";
      setMsg({ ok: data.status.enabled || kind === "remove", text: `${text} ${data.status.reason} Other replicas follow within a minute.` });
      router.refresh();
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mb-6">
      <div id="news-agent" className="flex flex-wrap items-baseline justify-between gap-2 scroll-mt-24">
        <h2 className="font-semibold text-fg">
          News agent <StatusPill status={st.enabled ? "ok" : "not configured"} />
        </h2>
        <Button type="button" variant="secondary" size="sm" loading={busy === "check"} disabled={busy !== null} onClick={() => send("check")}>
          Check again
        </Button>
      </div>
      <p className="mt-2 text-sm text-fg-muted [overflow-wrap:anywhere]">{st.reason}</p>
      <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
        <dt className="text-fg-subtle">Endpoint</dt>
        <dd className="font-mono text-xs [overflow-wrap:anywhere]">{st.url ?? "none"}{st.source ? <span className="ml-2 font-sans text-fg-subtle">({SOURCE[st.source]})</span> : null}</dd>
        {st.version ? (
          <>
            <dt className="text-fg-subtle">Version</dt>
            <dd className="font-mono text-xs">{st.version}</dd>
          </>
        ) : null}
        {st.tried.length ? (
          <>
            <dt className="text-fg-subtle">Discovery tried</dt>
            <dd className="font-mono text-xs [overflow-wrap:anywhere]">{st.tried.join(", ")}</dd>
          </>
        ) : null}
        <dt className="text-fg-subtle">Checked</dt>
        <dd className="text-xs">{st.checkedAt.slice(0, 19).replace("T", " ")} UTC</dd>
      </dl>
      {!st.enabled && <p className="mt-3 text-sm text-fg-muted">Until it is found, no news job, test or cover runs. Jobs, sources and profiles can still be edited.</p>}
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send("save");
        }}
      >
        <Field
          label="Endpoint"
          htmlFor="news-agent-url"
          optional
          hint={
            st.envUrl
              ? `NEWS_AGENT_URL is set (${st.envUrl}): it is used, and this field is not.`
              : "Only when discovery does not find it, e.g. http://news-agent.other-namespace:8080. NEWS_AGENT_TOKEN is sent to this address: enter only an agent you run."
          }
        >
          <Input id="news-agent-url" type="url" inputMode="url" placeholder="http://news-agent:8080" value={url} disabled={locked || busy !== null} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" loading={busy === "save"} disabled={locked || busy !== null || !url.trim()}>
            Save and check
          </Button>
          {st.adminUrl && (
            <Button type="button" variant="secondary" size="sm" loading={busy === "remove"} disabled={locked || busy !== null} onClick={() => send("remove")}>
              Remove (use discovery)
            </Button>
          )}
        </div>
      </form>
      {msg && (
        <div className="mt-3">
          <Alert tone={msg.ok ? "success" : "error"}>
            {msg.text}
            {msg.issues?.length ? <span className="block">{msg.issues.join(" ")}</span> : null}
          </Alert>
        </div>
      )}
    </Card>
  );
}
