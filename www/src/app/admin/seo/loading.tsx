/** Skeleton while an SEO view loads. */
export default function SeoLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading SEO data…</span>
      <div className="skeleton h-8 w-64" />
      <div className="skeleton mt-6 h-14 rounded-xl" />
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-32 rounded-xl" />)}
      </div>
      <div className="skeleton mt-6 h-48 rounded-xl" />
    </div>
  );
}
