"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Turnstile } from "@/components/Turnstile";
import { Alert, Button, Field, Input } from "@/components/ui/form";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { authClient } from "@/lib/auth-client";
import { PASSWORD_HINT, PASSWORD_MIN, passwordProblem } from "@/lib/password-policy";

export function LoginForm({
  siteKey,
  registrationOpen,
  next,
  initialMode = "signin",
  canReset = false,
}: {
  siteKey: string | undefined;
  registrationOpen: boolean;
  next: string;
  /** "signup" when a page sent the visitor here to register (e.g. /login?mode=signup from Python practice). */
  initialMode?: "signin" | "signup";
  /** The site can send email: offer "Forgot password?" (it needs a reset link by email). */
  canReset?: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">(registrationOpen ? initialMode : "signin");
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError("Please complete the human verification.");
      return;
    }
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const problem = mode === "signup" ? passwordProblem(password) : null;
    if (problem) {
      setError(problem);
      return;
    }
    const fetchOptions = { headers: { "x-captcha-response": token } };
    setBusy(true);
    const result =
      mode === "signin"
        ? await authClient.signIn.email({ email, password, fetchOptions })
        : await authClient.signUp.email({ email, password, name: String(form.get("name") ?? ""), fetchOptions });
    setBusy(false);
    if (result.error) {
      // 403 EMAIL_NOT_VERIFIED: sign-in sent a fresh verification link (auth.ts, sendOnSignIn).
      const unverified = result.error.code === "EMAIL_NOT_VERIFIED";
      setError(unverified ? "Confirm your email address first: we've just sent you a new link." : (result.error.message ?? "Something went wrong. Please try again."));
      setToken(null);
      setResetKey((k) => k + 1); // tokens are single-use
      return;
    }
    // Sign-up while verification is required returns no session: the account works once the emailed link is clicked.
    if (mode === "signup" && !(result.data && "token" in result.data && result.data.token)) {
      setCheckEmail(true);
      return;
    }
    router.push(next);
    router.refresh();
  }

  if (!siteKey) return <Alert tone="info">Email sign-in is unavailable: human verification is not configured.</Alert>;
  if (checkEmail) {
    return <Alert tone="success">Almost done: we&apos;ve sent a link to your email address. Click it to confirm the address and you&apos;ll be signed in.</Alert>;
  }

  return (
    <div>
      {registrationOpen && (
        <div role="group" aria-label="Email sign-in or new account" className="mb-5 grid grid-cols-2 rounded-lg bg-surface-sunken p-1">
          {(["signin", "signup"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`min-h-10 rounded-md text-sm font-semibold transition-colors ${
                mode === m ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg"
              }`}
            >
              {m === "signin" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="space-y-5" noValidate>
        {mode === "signup" && (
          <Field label="Name" htmlFor="name">
            <Input id="name" name="name" autoComplete="name" required minLength={2} maxLength={80} />
          </Field>
        )}
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" htmlFor="password" hint={mode === "signup" ? PASSWORD_HINT : undefined}>
          <PasswordInput
            id="password"
            name="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            required
            minLength={mode === "signup" ? PASSWORD_MIN : 1}
            aria-describedby={mode === "signup" ? "password-hint" : undefined}
          />
        </Field>
        {mode === "signin" && canReset && (
          <p className="-mt-2 text-right text-sm">
            <Link href="/forgot-password" className="link">
              Forgot password?
            </Link>
          </p>
        )}
        <Turnstile siteKey={siteKey} onToken={setToken} resetKey={resetKey} />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" loading={busy} size="lg" className="w-full">
          {busy ? "Please wait…" : mode === "signin" ? "Sign in with email" : "Create account"}
        </Button>
      </form>
    </div>
  );
}
