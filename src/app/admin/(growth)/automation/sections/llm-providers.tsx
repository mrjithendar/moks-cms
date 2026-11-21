import Link from "next/link";
import { Card } from "@/components/admin/ui";
import { getSeoSettings, claudeConfig } from "@/lib/seo-intel/settings";

/**
 * AI & SEO settings → LLM providers & models. A placeholder that states what exists today; the provider catalogue,
 * keys, model list and "model for each job" arrive with the providers work (plan P2), which replaces this file.
 */
export default async function LlmProvidersSection() {
  const claude = await getSeoSettings().then(claudeConfig).catch(() => null);
  return (
    <Card className="mb-6">
      <h2 className="text-lg font-semibold text-fg">LLM providers &amp; models</h2>
      <p className="mt-1 text-sm text-fg-muted">Which model providers the site may call, and which model does each job.</p>
      <dl className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="font-medium text-fg">SEO agent</dt>
        <dd className="text-fg-muted">Calls Anthropic&apos;s Claude for every flow, crew, Ask the Blog answer and news draft. No other provider can be chosen for it yet.</dd>
        <dt className="font-medium text-fg">Models in use</dt>
        <dd className="text-fg-muted">
          {claude ? (
            <>
              Drafting: <code>{claude.draftModel}</code>. Classifying: <code>{claude.classifyModel}</code>. Change them under{" "}
              <Link className="underline" href="/admin/automation?section=ai">AI &amp; drafts</Link>; a crew agent&apos;s own model is set under <Link className="underline" href="/admin/crewai/crews">Crews</Link>.
            </>
          ) : (
            "The SEO settings could not be read."
          )}
        </dd>
        <dt className="font-medium text-fg">API key</dt>
        <dd className="text-fg-muted">{claude ? (claude.apiKey ? "An Anthropic key is set." : "No Anthropic key is set: drafting and reviews use rules only.") : "Unknown."}</dd>
        <dt className="font-medium text-fg">Elsewhere</dt>
        <dd className="text-fg-muted">
          Practice hints have their own provider and model under <Link className="underline" href="/admin/practice">Practice</Link>. Image generation keys are under <Link className="underline" href="/admin/integrations">Integrations</Link>.
        </dd>
      </dl>
    </Card>
  );
}
