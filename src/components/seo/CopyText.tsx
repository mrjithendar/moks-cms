"use client";

import { useState } from "react";
import { Button } from "@/components/ui/form";

/** A read-only block of text with a Copy button (the promotion digest). */
export function CopyText({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-2">
      <textarea readOnly value={text} rows={Math.min(18, text.split("\n").length + 1)} className="w-full rounded-md border border-line bg-surface-muted p-3 font-mono text-xs leading-5 text-fg" onFocus={(e) => e.currentTarget.select()} />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : label}
        </Button>
      </div>
    </div>
  );
}
