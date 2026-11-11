"use client";

/** Error state for SEO views: the server logged the details; the reference (digest) identifies the log line. */
export default function SeoError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
      <p className="font-semibold">This SEO view could not be loaded.</p>
      <p className="mt-1">The error has been logged{error.digest ? ` (reference ${error.digest})` : ""}.</p>
      <button type="button" onClick={reset} className="mt-3 underline">Try again</button>
    </div>
  );
}
