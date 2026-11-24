"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/components/news/api";
import type { CatalogKind } from "@/lib/crewai/catalog-shared";
import { ConfirmDialog } from "./ConfirmDialog";

/** Save an earlier version of a spec as the newest one (checked again by the SEO agent). */
export function RestoreVersionButton({ kind, itemKey, version }: { kind: CatalogKind; itemKey: string; version: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button type="button" className="text-xs font-medium text-accent-text hover:underline" onClick={() => setOpen(true)}>Restore</button>
      <ConfirmDialog
        open={open}
        title={`Restore v${version}?`}
        confirmLabel="Restore as the newest version"
        tone="primary"
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          try {
            await api(`/api/admin/crewai/catalog/${kind === "crew" ? "crews" : "flows"}/${itemKey}`, "POST", { action: "restore-version", version });
            setOpen(false);
            router.refresh();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>Its spec is saved again as a new version (the SEO agent checks it first). Nothing in between is lost.</p>
        {error && <p className="text-red-700 dark:text-red-300">{error}</p>}
      </ConfirmDialog>
    </>
  );
}
