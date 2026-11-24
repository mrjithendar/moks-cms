"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/crewai/ConfirmDialog";
import { Button } from "@/components/ui/form";
import { BASE, call } from "./api";

/** Put the configuration back as it was before one import (a new import of its snapshot; it removes what that added). */
export function RollbackButton({ id, when }: { id: string; when: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>Roll back</Button>
      <ConfirmDialog
        open={open}
        title="Roll this import back?"
        confirmLabel="Roll back"
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          try {
            await call(`${BASE}/syncs/${id}/rollback`, { method: "POST", body: {} });
            setOpen(false);
            router.refresh();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>The configuration goes back to how it was before the import of {when}: what it changed is changed back and what it added is removed (crews and flows are deleted, restorable). It is recorded as a new import. Git is not changed: write the result to the repository afterwards if Git should follow.</p>
        {error && <p className="text-red-700 dark:text-red-300">{error}</p>}
      </ConfirmDialog>
    </>
  );
}
