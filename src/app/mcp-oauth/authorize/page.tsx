import { redirect } from "next/navigation";
import { decide } from "./actions";
import { denyUrl, parseAuthorize, SCOPES } from "@/lib/mcp-oauth/oauth";
import { mcpEnabled } from "@/lib/seo-agent/endpoint";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connect an AI assistant", robots: { index: false, follow: false } };

/**
 * OAuth consent for the admin MCP server (authorization endpoint). Outside /admin on purpose: the admin layout would
 * send a signed-out admin back to /admin after sign-in and drop these parameters.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const q = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) as Record<string, string | undefined>;
  const self = `/mcp-oauth/authorize?${new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => typeof e[1] === "string"))}`;
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(self)}`);
  if (!(await mcpEnabled("admin"))) return <Message title="Not available">The admin MCP server is switched off (ADMIN_MCP_ENABLED, or the SEO agent is disabled).</Message>;
  if (user.role !== "admin") return <Message title="Admins only">Only the site admin can connect an AI assistant to the SEO tools.</Message>;
  const r = await parseAuthorize(q);
  if ("show" in r) return <Message title="Cannot connect">{r.show}</Message>;
  if ("back" in r) redirect(denyUrl(r.back, r.back.error, r.back.description));
  const req = r.ok;
  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-fg">Connect “{req.clientName}”?</h1>
        <p className="mt-2 text-sm text-fg-muted">
          It will act as <strong>{user.email}</strong> on the jithendar.com SEO tools and return to <span className="font-mono text-xs">{new URL(req.redirectUri).host}</span>.
        </p>
        <h2 className="mt-5 text-sm font-semibold text-fg">It will be able to</h2>
        <ul className="mt-2 space-y-2 text-sm">
          {req.scopes.map((s) => (
            <li key={s} className="flex gap-2">
              <span aria-hidden className="mt-0.5 text-accent">●</span>
              <span>
                <span className="font-mono text-xs text-fg-subtle">{s}</span>
                <br />
                {SCOPES[s]}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-5 rounded-lg bg-surface-sunken p-3 text-sm text-fg-muted">
          It can <strong>never</strong> approve or publish a draft, roll back, or submit pages to search engines. Approval stays on this site&apos;s review page. You can revoke access any time in SEO › Settings › MCP access.
        </p>
        <form action={decide} className="mt-6 flex gap-3">
          {Object.entries(q).map(([k, v]) => (typeof v === "string" ? <input key={k} type="hidden" name={`q_${k}`} value={v} /> : null))}
          <button name="decision" value="allow" className="min-h-11 flex-1 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent hover:bg-accent-hover">Allow</button>
          <button name="decision" value="deny" className="min-h-11 flex-1 rounded-lg border border-line-strong px-4 text-sm font-medium text-fg hover:bg-surface-sunken">Deny</button>
        </form>
      </div>
    </main>
  );
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <div className="rounded-2xl border border-line bg-surface p-6">
        <h1 className="text-xl font-semibold text-fg">{title}</h1>
        <p className="mt-2 text-sm text-fg-muted">{children}</p>
      </div>
    </main>
  );
}
