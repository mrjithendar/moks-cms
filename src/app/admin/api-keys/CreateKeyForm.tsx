"use client";

import { useActionState, useState } from "react";
import { Alert, Button, Field, Input, Select } from "@/components/ui/form";
import { createKeyAction, type CreateKeyState } from "./actions";

export function CreateKeyForm() {
  const [state, action, pending] = useActionState<CreateKeyState, FormData>(createKeyAction, {});
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-4">
      {state.key && (
        <div className="space-y-2 rounded-xl border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <p className="text-sm font-semibold text-emerald-950 dark:text-emerald-100">Copy this key now. It will not be shown again.</p>
          <div className="flex gap-2">
            <code className="flex-1 overflow-x-auto rounded-lg bg-white px-3 py-2 font-mono text-sm dark:bg-black/30">{state.key}</code>
            <Button type="button" variant="secondary" onClick={async () => { await navigator.clipboard.writeText(state.key!); setCopied(true); }}>{copied ? "Copied" : "Copy"}</Button>
          </div>
        </div>
      )}
      {state.error && <Alert>{state.error}</Alert>}
      <form action={action} className="grid gap-4 sm:grid-cols-[1fr_auto_160px_auto] sm:items-end">
        <Field label="Name" htmlFor="name" hint="What will use this key?"><Input id="name" name="name" required placeholder="e.g. n8n drafting workflow" /></Field>
        <fieldset className="space-y-1 text-sm">
          <legend className="mb-1 font-medium text-fg">Scopes</legend>
          <label className="flex items-center gap-2"><input type="checkbox" name="scopes" value="posts:read" defaultChecked /> posts:read</label>
          <label className="flex items-center gap-2" title="Create drafts and edit posts that are still drafts. Cannot publish or delete. Use this for CI and drafting tools.">
            <input type="checkbox" name="scopes" value="posts:draft" /> posts:draft <span className="text-fg-subtle">(drafts only)</span>
          </label>
          <label className="flex items-center gap-2" title="Everything you can do in the editor, publishing included, and moving posts to the trash.">
            <input type="checkbox" name="scopes" value="posts:write" /> posts:write <span className="text-fg-subtle">(can publish)</span>
          </label>
          <label className="flex items-center gap-2" title="Push site images (/images/…) to storage: new images and replacements. Admins only: a site image can be part of any page.">
            <input type="checkbox" name="scopes" value="images:write" /> images:write <span className="text-fg-subtle">(site images, admins)</span>
          </label>
          <label className="flex items-center gap-2" title="Export the CrewAI configuration bundle and read its sync status. No secrets are in either. Admins only.">
            <input type="checkbox" name="scopes" value="crewai:read" /> crewai:read <span className="text-fg-subtle">(configuration export, admins)</span>
          </label>
          <label className="flex items-center gap-2" title="Import a CrewAI configuration bundle: plans, or applied in one transaction. A deployment restores crewconfig/ with it. Admins only.">
            <input type="checkbox" name="scopes" value="crewai:import" /> crewai:import <span className="text-fg-subtle">(configuration import, admins)</span>
          </label>
        </fieldset>
        <Field label="Expires" htmlFor="expiresInDays">
          <Select id="expiresInDays" name="expiresInDays" defaultValue="90">
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
            <option value="0">Never</option>
          </Select>
        </Field>
        <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create key"}</Button>
      </form>
    </div>
  );
}
