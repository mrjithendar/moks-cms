import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/AuthCard";
import { Alert } from "@/components/ui/form";
import { ResetPasswordForm } from "./ResetPasswordForm";

export const metadata: Metadata = { title: "Choose a new password", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Where the reset email's link lands: Better Auth checks the token, then redirects here with ?token= or ?error=. */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string; invite?: string }> }) {
  const { token, error, invite } = await searchParams;
  const usable = typeof token === "string" && token.length > 0 && !error;
  // A demo invitation (lib/demo.ts) uses the same link; only the wording and where sign-in leads differ.
  const demo = invite === "demo";

  return (
    <AuthCard
      title={demo ? "Set your password" : "Choose a new password"}
      intro={demo ? "Choose a password for your read-only demo account. Pick one you don't use anywhere else." : "Pick a password you don't use anywhere else. Every other signed-in device is signed out."}
      footer={
        <Link href="/login" className="link">
          Back to sign in
        </Link>
      }
    >
      {usable ? (
        <ResetPasswordForm token={token} signInHref={demo ? "/login?next=%2Fadmin" : "/login"} />
      ) : (
        <Alert>
          {demo ? "This invitation link is invalid or has expired (it works once, for 3 days)." : "This reset link is invalid or has expired (links work once, for an hour)."}{" "}
          <Link href="/forgot-password" className="underline">
            Ask for a new one
          </Link>
          .
        </Alert>
      )}
    </AuthCard>
  );
}
