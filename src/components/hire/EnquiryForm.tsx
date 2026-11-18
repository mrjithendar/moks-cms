"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { submitEnquiryAction } from "@/app/_actions/public";
import { Turnstile } from "@/components/Turnstile";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui/form";
import { authClient } from "@/lib/auth-client";
import { BUDGETS, ENQUIRY_KINDS, ENQUIRY_LABELS, TIMELINES, type EnquiryKind } from "@/lib/hire-me";
import { trackLead } from "./track";

/**
 * The Hire me enquiry form. Signed-in readers skip Turnstile (checked again on the server from the session); the
 * session is read in the browser so /hire-me stays a cached page. Budget appears only for paid project work.
 */
export function EnquiryForm({ siteKey, responseTime, initialKind = "consulting" }: { siteKey: string | undefined; responseTime: string; initialKind?: EnquiryKind }) {
  const { data: session } = authClient.useSession();
  const signedIn = Boolean(session?.user);
  const [kind, setKind] = useState<EnquiryKind>(initialKind);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [result, setResult] = useState<{ ok: boolean; text: string; issues?: string[] } | null>(null);
  const [pending, start] = useTransition();
  const showBudget = kind === "consulting" || kind === "freelance";

  // "Enquire" on an offer links to #enquiry-<kind>: preselect that kind (read in the browser, so the page stays static).
  useEffect(() => {
    const fromHash = () => {
      const k = globalThis.location?.hash.replace(/^#enquiry-/, "");
      if (k && (ENQUIRY_KINDS as readonly string[]).includes(k)) setKind(k as EnquiryKind);
    };
    fromHash();
    globalThis.addEventListener("hashchange", fromHash);
    return () => globalThis.removeEventListener("hashchange", fromHash);
  }, []);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    if (!signedIn && siteKey && !token) {
      setResult({ ok: false, text: "Please complete the human verification." });
      return;
    }
    start(async () => {
      const r = await submitEnquiryAction(
        { kind, name: f.name ?? "", email: f.email ?? "", company: f.company ?? "", budget: showBudget ? (f.budget ?? "") : "", timeline: f.timeline ?? "", message: f.message ?? "" },
        token,
      );
      setResult(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error, issues: r.issues });
      setToken(null);
      setResetKey((k) => k + 1);
      if (r.ok) {
        trackLead("enquiry_submitted", kind);
        form.reset();
      }
    });
  }

  if (!siteKey && !signedIn) {
    return <Alert tone="info">The enquiry form needs human verification (Cloudflare Turnstile), which is not configured yet.</Alert>;
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2" aria-describedby="enquiry-note">
      <div className="sm:col-span-2">
        <Field label="What do you need help with?" htmlFor="q-kind">
          <Select id="q-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as EnquiryKind)} required>
            {ENQUIRY_KINDS.map((k) => (
              <option key={k} value={k}>{ENQUIRY_LABELS[k]}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Name" htmlFor="q-name"><Input id="q-name" name="name" autoComplete="name" required maxLength={100} /></Field>
      <Field label="Email" htmlFor="q-email"><Input id="q-email" name="email" type="email" autoComplete="email" required maxLength={200} /></Field>
      <Field label="Company or event (optional)" htmlFor="q-company"><Input id="q-company" name="company" autoComplete="organization" maxLength={120} /></Field>
      <Field label="Timeline (optional)" htmlFor="q-timeline">
        <Select id="q-timeline" name="timeline" defaultValue="">
          <option value="">Choose…</option>
          {TIMELINES.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
      </Field>
      {showBudget && (
        <div className="sm:col-span-2">
          <Field label="Budget (optional, in your currency)" htmlFor="q-budget">
            <Select id="q-budget" name="budget" defaultValue="">
              <option value="">Choose…</option>
              {BUDGETS.map((b) => <option key={b} value={b}>{b}</option>)}
            </Select>
          </Field>
        </div>
      )}
      <div className="sm:col-span-2">
        <Field label="What are you working on?" htmlFor="q-message">
          <Textarea id="q-message" name="message" rows={6} required minLength={20} maxLength={5000}
            placeholder="The goal, your current setup (cloud, Kubernetes, CI/CD, AI tooling) and what a good outcome looks like." />
        </Field>
      </div>
      <div className="space-y-4 sm:col-span-2">
        {!signedIn && siteKey && <Turnstile siteKey={siteKey} onToken={setToken} resetKey={resetKey} />}
        {result && (
          <Alert tone={result.ok ? "success" : "error"}>
            {result.text}
            {result.issues && <ul className="mt-1 list-disc pl-5">{result.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
          </Alert>
        )}
        <Button type="submit" disabled={pending}>{pending ? "Sending…" : "Send enquiry"}</Button>
        <p id="enquiry-note" className="text-xs text-fg-subtle">
          {responseTime} Your details are used only to reply to this enquiry and are read only by me. See the{" "}
          <Link href="/privacy-policy" className="underline">privacy policy</Link>.
        </p>
      </div>
    </form>
  );
}
