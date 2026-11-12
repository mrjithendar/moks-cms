"use client";

import { useState } from "react";
import { Turnstile } from "@/components/Turnstile";
import { Alert, Button, Field, Input } from "@/components/ui/form";
import { authClient } from "@/lib/auth-client";

/**
 * Asks Better Auth to email a reset link. The answer is the same whether or not the address has an account, so the
 * form cannot be used to find out who is registered. The link lands on /reset-password?token=….
 */
export function ForgotPasswordForm({ siteKey }: { siteKey: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError("Please complete the human verification.");
      return;
    }
    const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
    setBusy(true);
    const result = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password", fetchOptions: { headers: { "x-captcha-response": token } } });
    setBusy(false);
    setToken(null);
    setResetKey((k) => k + 1); // tokens are single-use
    if (result.error) {
      setError(result.error.message ?? "Something went wrong. Please try again.");
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <Alert tone="success">
        If an account uses that address, a reset link is on its way. It works once and expires in an hour. Check your spam folder if it does not arrive in a few minutes.
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Turnstile siteKey={siteKey} onToken={setToken} resetKey={resetKey} />
      {error && <Alert>{error}</Alert>}
      <Button type="submit" loading={busy} size="lg" className="w-full">
        {busy ? "Sending…" : "Email me a reset link"}
      </Button>
    </form>
  );
}
