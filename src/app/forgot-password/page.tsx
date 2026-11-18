import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/AuthCard";
import { Alert } from "@/components/ui/form";
import { mailConfigured } from "@/lib/mail";
import { getSessionUser } from "@/lib/session";
import { turnstileKeys } from "@/lib/turnstile";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const metadata: Metadata = { title: "Reset your password", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage() {
  // Signed in: the password is changed in account settings, with the current one.
  if (await getSessionUser()) redirect("/account/settings");
  const [{ siteKey }, canEmail] = await Promise.all([turnstileKeys(), mailConfigured()]);

  return (
    <AuthCard
      title="Reset your password"
      intro="Enter the email address you sign in with and we'll send you a link to choose a new password."
      footer={
        <Link href="/login" className="link">
          Back to sign in
        </Link>
      }
    >
      {!canEmail ? (
        <Alert tone="info">Password reset by email is not available right now. Sign in with Google or GitHub if you connected one, or use the contact page.</Alert>
      ) : !siteKey ? (
        <Alert tone="info">Password reset is unavailable: human verification is not configured.</Alert>
      ) : (
        <ForgotPasswordForm siteKey={siteKey} />
      )}
    </AuthCard>
  );
}
