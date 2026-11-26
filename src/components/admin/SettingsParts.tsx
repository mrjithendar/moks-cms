import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/admin/ui";

/**
 * The heading of a section of Settings: its name, what it does, and on the right whatever describes its state (a status
 * pill, where the value comes from). Every section of the Settings area starts with one, so they read alike.
 */
export function SectionHeading({ id, title, description, aside }: { id: string; title: string; description?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-72">
        <h2 id={id} className="scroll-mt-24 text-lg font-semibold text-fg">
          {title}
        </h2>
        {description && <div className="mt-1 max-w-3xl text-sm leading-6 text-fg-muted">{description}</div>}
      </div>
      {aside && <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-fg-subtle">{aside}</div>}
    </div>
  );
}

/** A pointer from Settings to the page where the records and operations of the same feature are (bookings, payments, purges…). */
export function SeeAlso({ href, children }: { href: string; children: ReactNode }) {
  return (
    <p className="text-sm text-fg-muted">
      <Link href={href} className="link">
        {children}
      </Link>
    </p>
  );
}

/**
 * On a feature page: where its settings are now (lib/settings-areas.ts). A plain line at the end of the page, so the
 * page holds its records and operations and the settings have one home.
 */
export function SettingsElsewhere({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Card className="mt-10">
      <p className="text-sm text-fg-muted">
        <span className="font-semibold text-fg">Settings: </span>
        {children}{" "}
        <Link href={href} className="link whitespace-nowrap">
          Open settings
        </Link>
      </p>
    </Card>
  );
}
