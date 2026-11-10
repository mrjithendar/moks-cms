"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, type ButtonVariant } from "@/components/ui/form";

/**
 * Calls an /api/admin/seo endpoint with a JSON body and refreshes the page. Shows the API's own message (errors
 * are already redacted server-side). `confirm` asks first for anything that queues heavy work.
 */
export function ApiButton({ url, method = "POST", body, label, confirm, variant = "secondary", size = "sm", onDone }: {
  url: string;
  method?: "POST" | "PATCH" | "PUT";
  body?: unknown;
  label: string;
  confirm?: string;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  onDone?: (data: unknown) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        variant={variant}
        size={size}
        loading={busy}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setMsg(null);
          try {
            const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
            const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; reference?: string };
            if (!res.ok) setMsg({ ok: false, text: [data.error ?? `HTTP ${res.status}`, ...(data.issues ?? [])].join(" ") + (data.reference ? ` (ref ${data.reference})` : "") });
            else {
              setMsg({ ok: true, text: "Done." });
              onDone?.(data);
              router.refresh();
            }
          } catch {
            setMsg({ ok: false, text: "Network error." });
          } finally {
            setBusy(false);
          }
        }}
      >
        {label}
      </Button>
      {msg && <span role="status" className={`text-xs ${msg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>{msg.text}</span>}
    </span>
  );
}
