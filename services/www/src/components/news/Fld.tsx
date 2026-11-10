import type { ReactNode } from "react";

/** Label wrapping its control (implicit association), hint below it (not part of the accessible name). */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block space-y-1.5">
        <span className="block text-sm font-medium text-fg">{label}</span>
        {children}
      </label>
      {hint && <p className="text-xs leading-5 text-fg-subtle">{hint}</p>}
    </div>
  );
}
