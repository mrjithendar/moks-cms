import Link from "next/link";
import { LocalTime } from "@/components/LocalTime";
import { Flash, type FlashParams } from "@/components/admin/Flash";
import { AdminHeader, Card, StatusPill } from "@/components/admin/ui";
import { Button } from "@/components/ui/form";
import { adminActor } from "@/lib/admin";
import { absoluteUrl } from "@/config/site";
import { deleteBooking, listBookings, type BookingFilter } from "@/lib/calcom";
import { flash } from "@/lib/flash";
import { effectiveEnv } from "@/lib/runtime-settings";
import { requireRole } from "@/lib/session";

export const metadata = { title: "Bookings" };

const FILTERS: BookingFilter[] = ["upcoming", "past", "cancelled", "all"];

async function act(form: FormData) {
  "use server";
  const actor = await adminActor();
  const back = `/admin/bookings?status=${String(form.get("back") ?? "upcoming")}`;
  await flash(back, async () => {
    await deleteBooking(actor, String(form.get("id")));
    return "Removed from this list (the booking in Cal.com is unchanged).";
  });
}

export default async function BookingsPage({ searchParams }: { searchParams: FlashParams }) {
  await requireRole("admin");
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f === sp.status) ?? "upcoming";
  const [rows, env] = await Promise.all([listBookings(filter), effectiveEnv()]);
  return (
    <>
      <AdminHeader title="Bookings" description="Meetings booked through Cal.com from the Hire me page, received by webhook. Manage, reschedule or cancel them in Cal.com." />
      <Flash ok={sp.ok} error={sp.error} />
      {!env.CAL_WEBHOOK_SECRET && (
        <Card>
          <p className="text-sm text-fg-muted">
            Not connected yet. In Cal.com: Settings → Developer → Webhooks → New, subscriber URL <code>{absoluteUrl("/api/cal/webhook")}</code>, booking events, and a
            secret; then paste the secret in <Link href="/admin/advanced" className="underline">Advanced settings → Cal.com bookings</Link>.
          </p>
        </Card>
      )}
      <nav aria-label="Filter bookings" className="my-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link key={f} href={`/admin/bookings?status=${f}`} aria-current={f === filter ? "page" : undefined}
            className={`rounded-full px-3 py-1 text-sm font-medium capitalize ${f === filter ? "bg-fg text-canvas" : "border border-slate-200 dark:border-white/10"}`}>
            {f}
          </Link>
        ))}
      </nav>
      <div className="space-y-4">
        {rows.length === 0 && <p className="text-sm text-slate-500">No bookings.</p>}
        {rows.map((b) => (
          <Card key={b.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-fg">{b.title || b.eventType || "Booking"}</span>
              <span className="flex items-center gap-2 text-sm text-slate-500">
                <StatusPill status={b.status} />
                {b.startTime && <LocalTime iso={b.startTime.toISOString()} />}
              </span>
            </div>
            <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm text-fg-muted sm:grid-cols-2">
              {b.attendeeName && <div><dt className="inline font-semibold">With: </dt><dd className="inline">{b.attendeeName} {b.attendeeEmail && <>&lt;{b.attendeeEmail}&gt;</>}</dd></div>}
              {b.attendeeTimeZone && <div><dt className="inline font-semibold">Their time zone: </dt><dd className="inline">{b.attendeeTimeZone}</dd></div>}
              {b.eventType && <div><dt className="inline font-semibold">Event: </dt><dd className="inline">{b.eventType}</dd></div>}
              {b.location && <div><dt className="inline font-semibold">Location: </dt><dd className="inline break-all">{b.location}</dd></div>}
              {b.cancellationReason && <div className="sm:col-span-2"><dt className="inline font-semibold">Reason: </dt><dd className="inline">{b.cancellationReason}</dd></div>}
            </dl>
            {b.notes && <p className="mt-3 whitespace-pre-line break-words text-slate-800 dark:text-slate-200">{b.notes}</p>}
            <form action={act} className="mt-4 flex flex-wrap gap-2">
              <input type="hidden" name="id" value={b.id} />
              <input type="hidden" name="back" value={filter} />
              {b.attendeeEmail && (
                <a href={`mailto:${b.attendeeEmail}?subject=${encodeURIComponent("Re: " + (b.title || "our call"))}`} className="inline-flex items-center rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent">Email</a>
              )}
              <Button type="submit" variant="ghost">Remove from list</Button>
            </form>
          </Card>
        ))}
      </div>
    </>
  );
}
