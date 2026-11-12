"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Button, Field } from "@/components/ui/form";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { authClient } from "@/lib/auth-client";
import { PASSWORD_HINT, PASSWORD_MIN, passwordProblem } from "@/lib/password-policy";

export function ResetPasswordForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const newPassword = String(form.get("password") ?? "");
    if (newPassword !== String(form.get("confirm") ?? "")) {
      setError("The two passwords do not match.");
      return;
    }
    // Checked again on the server (auth.ts, PASSWORD_ENDPOINTS), with the breached-password check.
    const problem = passwordProblem(newPassword);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    const result = await authClient.resetPassword({ newPassword, token });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? "Something went wrong. Please try again.");
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <Alert tone="success">
        Your password has been changed.{" "}
        <Link href="/login" className="underline">
          Sign in with it
        </Link>
        .
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <Field label="New password" htmlFor="password" hint={PASSWORD_HINT}>
        <PasswordInput id="password" name="password" autoComplete="new-password" required minLength={PASSWORD_MIN} aria-describedby="password-hint" />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm">
        <PasswordInput id="confirm" name="confirm" autoComplete="new-password" required minLength={PASSWORD_MIN} />
      </Field>
      {error && <Alert>{error}</Alert>}
      <Button type="submit" loading={busy} size="lg" className="w-full">
        {busy ? "Saving…" : "Save new password"}
      </Button>
    </form>
  );
}
