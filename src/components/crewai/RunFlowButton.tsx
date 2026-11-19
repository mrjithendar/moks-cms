"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog } from "@/components/admin/Dialog";
import { Button } from "@/components/ui/form";
import type { JsonSchema } from "@/lib/seo-agent/client";
import { ParamsForm } from "./ParamsForm";

type ApiError = { error?: string; issues?: string[]; reference?: string };
const message = (d: ApiError) => [d.error ?? "Something went wrong.", ...(d.issues ?? [])].join(" ") + (d.reference ? ` (ref ${d.reference})` : "");

/**
 * "Run with parameters" (Jenkins' Build with Parameters): a form built from the flow's input model, or the inputs as
 * JSON; Start run posts to /api/admin/crewai/flows/{name} and opens the new run. `blocked` explains why this flow is
 * not started from here; `schema` is null while the agent is off.
 */
export function RunFlowButton({ flow, label, schema, initial = {}, blocked = null, size = "sm", variant = "secondary" }: { flow: string; label: string; schema: JsonSchema | null; initial?: Record<string, unknown>; blocked?: string | null; size?: "sm" | "md"; variant?: "primary" | "secondary" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [inputs, setInputs] = useState<Record<string, unknown>>(initial);
  const [asJson, setAsJson] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    let body = inputs;
    if (asJson) {
      try {
        const parsed: unknown = JSON.parse(text || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch {
        setError("The inputs must be one JSON object.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/crewai/flows/${flow}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs: body }) });
      const data = (await res.json().catch(() => ({}))) as ApiError & { runId?: string };
      if (!res.ok || !data.runId) {
        setError(message(data));
        return;
      }
      setOpen(false);
      router.push(`/admin/crewai/runs/${data.runId}`);
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  };

  const disabled = Boolean(blocked) || !schema;
  return (
    <>
      <Button type="button" size={size} variant={variant} disabled={disabled} title={blocked ?? (schema ? undefined : "The SEO agent is off: its flows cannot be started.")} onClick={() => { setError(null); setOpen(true); }}>
        Run with parameters
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Run ${label}`}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (!asJson) setText(JSON.stringify(inputs, null, 2));
                else {
                  try {
                    setInputs(JSON.parse(text || "{}") as Record<string, unknown>);
                  } catch {
                    setError("Fix the JSON before going back to the form.");
                    return;
                  }
                }
                setError(null);
                setAsJson(!asJson);
              }}
            >
              {asJson ? "Edit as a form" : "Edit as JSON"}
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
              <Button type="button" loading={busy} onClick={() => void start()}>Start run</Button>
            </div>
          </div>
        }
      >
        <p className="mb-4 text-sm text-fg-muted">
          A manual run of <code>{flow}</code> in your name. The flow checks the inputs before it starts; leave a field empty for its default. If a run of this flow for the same target is going, it opens instead.
        </p>
        {asJson ? (
          <>
            <label htmlFor={`run-json-${flow}`} className="mb-1 block text-sm font-medium text-fg">Inputs (JSON)</label>
            <textarea id={`run-json-${flow}`} rows={12} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} className="block w-full rounded-lg border border-line-strong bg-surface p-3 font-mono text-sm text-fg" />
          </>
        ) : schema ? (
          <ParamsForm schema={schema} value={inputs} onChange={setInputs} idPrefix={`run-${flow}`} />
        ) : null}
        {error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
      </Dialog>
    </>
  );
}
