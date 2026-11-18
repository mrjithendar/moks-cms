"use server";

import { redirect } from "next/navigation";
import { adminActor } from "@/lib/admin";
import { createInvoice, invoiceInputFromForm, updateInvoice } from "@/lib/invoices";
import { PostError } from "@/lib/posts";

export type InvoiceFormState = { error?: string; issues?: string[] };

/**
 * Save the invoice form as a draft (a new one, or the draft whose id the form carries). On success the admin lands
 * on the invoice, where it can be checked and sent; on a validation error the form keeps what was typed.
 */
export async function saveInvoiceAction(_prev: InvoiceFormState, form: FormData): Promise<InvoiceFormState> {
  const actor = await adminActor();
  const id = String(form.get("id") ?? "");
  let target: string;
  try {
    const saved = id ? await updateInvoice(actor, id, invoiceInputFromForm(form)) : await createInvoice(actor, invoiceInputFromForm(form));
    target = `/admin/invoices/${saved.id}?ok=${encodeURIComponent("Draft saved. Check it, then send it to the client.")}`;
  } catch (error) {
    if (error instanceof PostError) return { error: error.message, issues: error.issues };
    if ((error as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw error;
    const { log } = await import("@/lib/log");
    log.error("invoice save failed", { err: error });
    return { error: "Something went wrong. The error has been logged." };
  }
  redirect(target);
}
