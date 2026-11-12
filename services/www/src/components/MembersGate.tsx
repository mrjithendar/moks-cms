"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { loadMembersContent } from "@/app/_actions/members";

type State = { name: "signin" } | { name: "loading" } | { name: "ready"; content: ReactNode } | { name: "error" };

/**
 * The end of a members-only article's public preview. Signed-out readers (and anyone without JavaScript) see the
 * prompt to sign in or create an account. For a signed-in reader the rest of the article is fetched from the
 * server, which checks the session, and shown in its place. The class `members-only` marks the gated section for
 * search engines (see the article's structured data).
 */
export function MembersGate({ collection, slug, path }: { collection: string; slug: string; path: string }) {
  const [state, setState] = useState<State>({ name: "signin" });

  useEffect(() => {
    let current = true;
    loadMembersContent(collection, slug)
      .then((r) => {
        if (!current) return;
        if (r.ok) setState({ name: "ready", content: r.content });
        else if (r.reason === "unavailable") setState({ name: "error" });
      })
      .catch(() => current && setState({ name: "error" }));
    return () => {
      current = false;
    };
  }, [collection, slug]);

  if (state.name === "ready") return <div className="members-only">{state.content}</div>;

  const next = encodeURIComponent(path);
  return (
    <div className="members-only not-prose relative mt-2">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-24 h-24 bg-gradient-to-b from-transparent to-canvas" />
      <section aria-labelledby="members-only-heading" className="rounded-2xl border border-line bg-surface-muted p-6 text-center sm:p-8">
        <p className="text-sm font-semibold text-accent-text">Members only</p>
        <h2 id="members-only-heading" className="mt-2 text-xl font-semibold text-fg text-balance">
          Sign in to read the rest of this article
        </h2>
        {state.name === "error" ? (
          <p role="alert" className="mt-3 text-[0.9375rem] leading-6 text-fg-muted">
            The rest of the article could not be loaded. Reload the page to try again.
          </p>
        ) : (
          <p className="mt-3 text-[0.9375rem] leading-6 text-fg-muted">You have read the free preview. An account is free and takes a minute.</p>
        )}
        <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href={`/login?mode=signup&next=${next}`} className="inline-flex min-h-11 items-center justify-center rounded-xl bg-accent px-5 text-sm font-semibold text-on-accent">
            Create a free account
          </Link>
          <Link href={`/login?next=${next}`} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-line-strong px-5 text-sm font-semibold text-fg">
            Sign in
          </Link>
        </div>
      </section>
    </div>
  );
}
