"use server";

import { headers } from "next/headers";
import { clientIp as clientIpFrom } from "@/lib/client-ip";
import { submitContact, submitEnquiry } from "@/lib/contact";
import { PostError } from "@/lib/posts";
import { getSessionUser } from "@/lib/session";

export type PublicResult = { ok: true; message: string } | { ok: false; error: string; issues?: string[] };

async function clientIp() {
  return clientIpFrom(await headers());
}

async function guard(fn: () => Promise<string>): Promise<PublicResult> {
  try {
    return { ok: true, message: await fn() };
  } catch (error) {
    if (error instanceof PostError) return { ok: false, error: error.message, issues: error.issues };
    const { currentRequestId, reportError, withReference } = await import("@/lib/http-errors");
    const ref = reportError("public form failed", error, { requestId: await currentRequestId() });
    return { ok: false, error: withReference("Something went wrong. Please try again later.", ref) };
  }
}

export async function submitContactAction(data: { name: string; email: string; subject: string; message: string }, token: string | null): Promise<PublicResult> {
  return guard(async () => {
    await submitContact(data, token, await clientIp(), { signedIn: !!(await getSessionUser()) });
    return "Thanks for getting in touch. Your message has been received.";
  });
}

/** Hire me (/hire-me): an enquiry about consulting, a project, a talk or mentoring. */
/** Plain strings from the form; validated (kind, choices, lengths) in submitEnquiry. */
export type EnquiryFields = { kind: string; name: string; email: string; company: string; budget: string; timeline: string; message: string };

export async function submitEnquiryAction(data: EnquiryFields, token: string | null): Promise<PublicResult> {
  return guard(async () => {
    await submitEnquiry(data, token, await clientIp(), { signedIn: !!(await getSessionUser()) });
    return "Thanks, your enquiry has been received. I'll reply by email.";
  });
}
