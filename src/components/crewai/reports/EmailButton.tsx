"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/form";
import { EmailDialog } from "./ReportClient";

/** SEO-AI reports: email one report from the list (recipients, attachment or link, preview), inline under its row. */
export function EmailButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <div>
      <Button size="sm" variant="secondary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Close" : "Email…"}</Button>
      {open && <EmailDialog id={id} onSent={() => router.refresh()} />}
    </div>
  );
}
