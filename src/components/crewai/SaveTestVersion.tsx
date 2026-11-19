"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input } from "@/components/ui/form";

/** From a crew test run's page: save the configuration it ran as the crew's next version (optionally active). */
export function SaveTestVersion({ crew, config, runId, label }: { crew: string; config: Record<string, unknown>; runId: string; label: string }) {
  const router = useRouter();
  const [note, setNote] = useState(`From test run ${label}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (activate: boolean) => {
    setBusy(activate ? "activate" : "save");
    setError(null);
    try {
      const res = await fetch(`/api/admin/crewai/crews/${crew}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", config, note, activate, fromRun: runId }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; version?: { version: number } };
      if (!res.ok) return setError([data.error ?? "Something went wrong.", ...(data.issues ?? [])].join(" "));
      router.push(`/admin/crewai/crews/${crew}?version=${data.version?.version}&saved=1`);
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-48 flex-1">
        <label htmlFor="test-note" className="text-xs font-medium text-fg-muted">Note for the new version</label>
        <Input id="test-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </div>
      <Button type="button" size="sm" variant="secondary" loading={busy === "save"} onClick={() => void save(false)}>Save as new version</Button>
      <Button type="button" size="sm" loading={busy === "activate"} onClick={() => void save(true)}>Save and activate</Button>
      {error && <p role="alert" className="w-full text-sm text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}
