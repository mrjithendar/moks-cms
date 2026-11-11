import Link from "next/link";
import { ArrowRight } from "@/components/icons";
import { hireCtaVisible, type HireMe } from "@/lib/hire-me";

/**
 * "Work with me" box at the end of articles (Admin → Appearance → Hire me → Call to action in articles). Rendered on
 * the server into the cached article page; hidden while the page is off or no new work is taken.
 */
export function HireCta({ hire }: { hire: HireMe }) {
  if (!hireCtaVisible(hire) || !hire.articleCta.enabled || !hire.articleCta.text) return null;
  return (
    <aside aria-label="Work with me" className="rounded-xl border border-accent/30 bg-surface p-5 sm:p-6">
      <p className="text-fg">{hire.articleCta.text}</p>
      <Link href="/hire-me" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-accent-text hover:underline">
        See how I can help <ArrowRight className="h-4 w-4" />
      </Link>
    </aside>
  );
}
