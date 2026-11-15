"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button, type ButtonVariant } from "@/components/ui/form";

function Submit({ variant, children }: { variant: ButtonVariant; children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} loading={pending}>
      {children}
    </Button>
  );
}

/**
 * A one-button form for a server action: hidden fields say what to do, `confirm` asks first, and the button shows
 * that the action is running (sending an invoice talks to Razorpay, storage and the mail server, which takes a moment).
 */
export function ActionButton({
  action,
  fields,
  confirm,
  variant = "secondary",
  children,
  extra,
}: {
  action: (form: FormData) => Promise<void>;
  fields: Record<string, string>;
  confirm?: string;
  variant?: ButtonVariant;
  children: ReactNode;
  /** Visible fields submitted with the button (a note, for example). */
  extra?: ReactNode;
}) {
  return (
    <form
      action={action}
      className={extra ? "flex flex-wrap items-end gap-2" : undefined}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {extra}
      <Submit variant={variant}>{children}</Submit>
    </form>
  );
}
