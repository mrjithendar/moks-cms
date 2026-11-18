"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Card } from "@/components/admin/ui";
import { Button } from "@/components/ui/form";

type Review = "pending" | "approved" | "rejected";
type Impl = "not_started" | "in_progress" | "implemented" | "dismissed";

/**
 * One recommendation with its actions. Approving or rejecting while a status filter is open moves the item out of
 * that list at once (a one-line "moved" notice with View and Undo replaces the card), then the page refreshes so the
 * tab counts and the other list catch up. With "all" the card stays and its status updates.
 */
export function RecommendationItem({ id, filter, reviewStatus, implementationStatus, children }: { id: string; filter: string; reviewStatus: Review; implementationStatus: Impl; children: ReactNode }) {
  const router = useRouter();
  const [review, setReview] = useState<Review>(reviewStatus);
  const [impl, setImpl] = useState<Impl>(implementationStatus);
  const [moved, setMoved] = useState<Review | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function patch(body: { reviewStatus?: Review; implementationStatus?: Impl }, key: string): Promise<boolean> {
    setBusy(key);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/seo/recommendations/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; reviewStatus?: Review; implementationStatus?: Impl };
      if (!res.ok) {
        setErr(data.error ?? `HTTP ${res.status}`);
        return false;
      }
      if (data.reviewStatus) setReview(data.reviewStatus);
      if (data.implementationStatus) setImpl(data.implementationStatus);
      return true;
    } catch {
      setErr("Network error.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function decide(to: Review) {
    if (!(await patch({ reviewStatus: to }, to))) return;
    if (filter !== "all" && filter !== to) setMoved(to);
    router.refresh();
  }

  if (moved) {
    return (
      <li className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-line px-4 py-3 text-sm text-fg-muted" role="status">
        <span>
          {moved === "approved" ? "Approved" : moved === "rejected" ? "Rejected" : "Moved back to pending"}: moved to the <strong className="text-fg">{moved}</strong> list.
        </span>
        <Link className="underline" href={`?status=${moved}`}>View</Link>
        <button
          type="button"
          className="underline"
          disabled={busy !== null}
          onClick={async () => {
            if (await patch({ reviewStatus: filter as Review }, "undo")) {
              setMoved(null);
              router.refresh();
            }
          }}
        >
          Undo
        </button>
        {err && <span className="text-xs text-red-700 dark:text-red-300">{err}</span>}
      </li>
    );
  }

  return (
    <li>
      <Card>
      {children}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {review !== "approved" && <Button type="button" size="sm" loading={busy === "approved"} disabled={busy !== null} onClick={() => decide("approved")}>Approve</Button>}
        {review !== "rejected" && <Button type="button" size="sm" variant="secondary" loading={busy === "rejected"} disabled={busy !== null} onClick={() => decide("rejected")}>Reject</Button>}
        {review !== "pending" && filter === "all" && <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => decide("pending")}>Back to pending</Button>}
        {review === "approved" && impl === "not_started" && (
          <Button type="button" size="sm" variant="secondary" loading={busy === "progress"} disabled={busy !== null} onClick={async () => (await patch({ implementationStatus: "in_progress" }, "progress")) && router.refresh()}>
            Mark in progress
          </Button>
        )}
        {review === "approved" && impl !== "implemented" && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={busy === "implemented"}
            disabled={busy !== null}
            onClick={async () => {
              if (!window.confirm("Mark as implemented? Baseline metrics are captured now; outcomes are measured after 28 and 56 days.")) return;
              if (await patch({ implementationStatus: "implemented" }, "implemented")) router.refresh();
            }}
          >
            Mark implemented
          </Button>
        )}
        {impl !== "not_started" && <span className="text-xs text-fg-subtle">implementation: {impl.replace("_", " ")}</span>}
        {err && <span role="alert" className="text-xs text-red-700 dark:text-red-300">{err}</span>}
      </div>
      </Card>
    </li>
  );
}
