import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { publicMcpEnabled } from "@/lib/seo-agent/config";
import { siteOrigin } from "@/lib/seo-intel/urls";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Use jithendar.com in your AI assistant",
  description: "Connect Claude or any MCP client to search and cite jithendar.com articles.",
  alternates: { canonical: "/ai-assistants" },
};

/** Shown only while the public MCP server is on (PUBLIC_MCP_ENABLED); otherwise 404 and no footer link. */
export default function AiAssistantsPage() {
  if (!publicMcpEnabled()) notFound();
  const url = `${siteOrigin().origin}/mcp/public`;
  const code = "rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[0.85em]";
  return (
    <main className="mx-auto max-w-[70ch] px-4 py-12 sm:py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-fg">Use jithendar.com in your AI assistant</h1>
      <p className="mt-4 text-lg text-fg-muted">
        The articles on this site are available to AI assistants through a read-only{" "}
        <a className="underline" href="https://modelcontextprotocol.io" rel="noopener">
          Model Context Protocol
        </a>{" "}
        server, so your assistant can search them and cite the exact section it used.
      </p>
      <h2 className="mt-10 text-xl font-semibold text-fg">Server URL</h2>
      <p className="mt-3">
        <code className={`${code} select-all`}>{url}</code> (Streamable HTTP, no sign-in)
      </p>
      <h2 className="mt-10 text-xl font-semibold text-fg">Connect</h2>
      <ul className="mt-3 list-disc space-y-2 pl-6 text-fg-muted">
        <li>
          <strong className="text-fg">Claude (desktop, web, mobile):</strong> Settings › Connectors › Add custom connector, paste the URL.
        </li>
        <li>
          <strong className="text-fg">Claude Code:</strong> <code className={code}>claude mcp add --transport http jithendar {url}</code>
        </li>
        <li>
          <strong className="text-fg">Other MCP clients:</strong> add a remote (Streamable HTTP) server with the URL above.
        </li>
      </ul>
      <h2 className="mt-10 text-xl font-semibold text-fg">What it offers</h2>
      <ul className="mt-3 list-disc space-y-2 pl-6 text-fg-muted">
        <li><code className={code}>search_articles</code>: search by meaning; results link to the article section.</li>
        <li><code className={code}>get_article</code>: read an article (or one section) as Markdown with its canonical URL.</li>
        <li><code className={code}>list_topics</code>: the site&apos;s topics with article counts.</li>
        <li><code className={code}>ask_blog</code>: a short answer with citations, from this site&apos;s articles only.</li>
        <li>A prompt, <code className={code}>explain_with_sources</code>, that asks your assistant to cite the URLs it used.</li>
      </ul>
      <h2 className="mt-10 text-xl font-semibold text-fg">Good to know</h2>
      <ul className="mt-3 list-disc space-y-2 pl-6 text-fg-muted">
        <li>Only published articles are available. Nothing you send is used to change the site.</li>
        <li>Requests are rate limited per address. Questions are kept briefly for abuse prevention, without your IP address.</li>
        <li>Please link to the article when you use what it says.</li>
      </ul>
    </main>
  );
}
