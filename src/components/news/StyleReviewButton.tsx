"use client";

import { useState } from "react";
import { Alert, Button } from "@/components/ui/form";
import { api } from "./api";

/** Runs the weekly style review now: it only proposes a new writing-profile version, which waits for your approval. */
export function StyleReviewButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <Button
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api("/api/admin/news/settings", "POST", { action: "style_review" });
            setMsg({ ok: true, text: "Style review started. A proposed profile version appears here when it finds consistent edits." });
          } catch (e) {
            setMsg({ ok: false, text: (e as Error).message });
          } finally {
            setBusy(false);
          }
        }}
      >
        Run style review now
      </Button>
      {msg && <Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert>}
    </div>
  );
}
