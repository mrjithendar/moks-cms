"use client";

import type { ReactNode } from "react";

/** A form with hidden fields whose submit asks first (window.confirm); used for Delete and Cancel on Admin → Backups. */
export function ConfirmSubmit({ action, fields, question, children, className }: { action: (form: FormData) => Promise<void>; fields: Record<string, string>; question: string; children: ReactNode; className?: string }) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(question)) e.preventDefault();
      }}
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" className={className ?? "font-semibold text-red-700 underline dark:text-red-400"}>
        {children}
      </button>
    </form>
  );
}
