import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminHeader, Card } from "@/components/admin/ui";
import { Badge } from "@/components/seo/badges";
import { Empty } from "@/components/seo/ui";
import { AI_PROVIDER_LABEL, NO_AI_OVERVIEW, promptHistory } from "@/lib/seo-intel/ai-visibility";
import { UUID } from "@/lib/seo-intel/http";
import { siteOrigin } from "@/lib/seo-intel/urls";

export const metadata = { title: "AI visibility · prompt" };

/** One prompt: every stored answer, newest first, with its sources (this site's highlighted). */
export default async function PromptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const h = await promptHistory(id);
  if (!h) notFound();
  const host = siteOrigin().hostname.replace(/^www\./, "");
  return (
    <>
      <AdminHeader title={h.prompt.prompt} description={`Added ${h.prompt.added_at.slice(0, 10)}${h.prompt.source === "search_console" ? " from Search Console" : ""}${h.prompt.active ? "" : " · paused"}. Answers are stored as the assistant's API returned them (first 8,000 characters).`} actions={<Link href="/admin/ai-visibility" className="inline-flex min-h-9 items-center rounded-md border border-line-strong px-3 text-sm">All prompts</Link>} />
      {h.answers.length ? (
        <ul className="grid gap-4">
          {h.answers.map((a) => (
            <li key={`${a.provider}-${a.run_on}`}>
              <Card className="!p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-fg">{AI_PROVIDER_LABEL[a.provider] ?? a.provider}</p>
                  <span className="text-xs text-fg-subtle">{a.run_on}{a.model ? ` · ${a.model}` : ""} · ${Number(a.cost_usd).toFixed(4)}</span>
                  {a.cited && <Badge t="green">cited #{a.cited_rank}</Badge>}
                  {!a.cited && a.mentioned && <Badge t="blue">mentioned</Badge>}
                  {a.error === NO_AI_OVERVIEW && <Badge>no AI Overview</Badge>}
                  {a.error && a.error !== NO_AI_OVERVIEW && <Badge t="amber" title={a.error}>error</Badge>}
                </div>
                {a.error && a.error !== NO_AI_OVERVIEW && <p className="mt-2 text-sm text-red-800 [overflow-wrap:anywhere] dark:text-red-300">{a.error}</p>}
                {a.answer && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm text-fg-muted">Answer</summary>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-fg [overflow-wrap:anywhere]">{a.answer}</p>
                  </details>
                )}
                {a.sources.length > 0 && (
                  <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm">
                    {a.sources.map((s) => {
                      const own = s.domain === host || s.domain.endsWith(`.${host}`);
                      return (
                        <li key={s.url} className={own ? "font-semibold text-fg" : "text-fg-muted"}>
                          <a href={s.url} rel="noopener noreferrer nofollow" target="_blank" className="hover:underline [overflow-wrap:anywhere]">{s.title || s.domain || s.url}</a> <span className="text-xs text-fg-subtle">{s.domain}</span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </Card>
            </li>
          ))}
        </ul>
      ) : <Empty>No answers yet: the prompt is asked on the next weekly run, or use Run now on the AI visibility page.</Empty>}
    </>
  );
}
