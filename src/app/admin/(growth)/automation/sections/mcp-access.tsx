import { Card, Table, td, th } from "@/components/admin/ui";
import { Empty, fmtWhen, Section } from "@/components/seo/ui";
import { listGrants, metadata as asMetadata, resourceUrl, SCOPES } from "@/lib/mcp-oauth/oauth";
import { mcpEnabled } from "@/lib/seo-agent/endpoint";
import { siteOrigin } from "@/lib/seo-intel/urls";
import { revokeGrant } from "../mcp/actions";

/**
 * AI & SEO settings → MCP access: who is connected to the admin MCP server, what they may do, and revoke. It was its
 * own page (/admin/automation/mcp, which now opens this section) until 2026-11-21.
 */
export default async function McpAccessSection() {
  const [grants, adminOn, publicOn] = await Promise.all([listGrants(), mcpEnabled("admin"), mcpEnabled("public")]);
  const origin = siteOrigin().origin;
  const on = (v: boolean) => <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${v ? "bg-green-50 text-green-800 dark:bg-green-500/10 dark:text-green-300" : "bg-surface-sunken text-fg-muted"}`}>{v ? "on" : "off"}</span>;
  return (
    <>
      <p className="text-sm text-fg-muted">AI assistants (Claude on your phone or desktop, MCP Inspector) connected to the SEO tools. They can read metrics, triage drafts and start drafting or sync flows. They can never approve, publish, roll back or submit to search engines: approval stays on the review page.</p>
      <Section title="Servers">
        <Card>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium">Admin server {on(adminOn)}</dt>
              <dd className="mt-1 font-mono text-xs text-fg-muted">{resourceUrl()}</dd>
              <dd className="mt-1 text-xs text-fg-subtle">OAuth 2.1 with PKCE · authorization server {asMetadata().issuer} · switch: ADMIN_MCP_ENABLED, and the SEO agent on</dd>
            </div>
            <div>
              <dt className="font-medium">Public server {on(publicOn)}</dt>
              <dd className="mt-1 font-mono text-xs text-fg-muted">{origin}/mcp/public</dd>
              <dd className="mt-1 text-xs text-fg-subtle">Read-only, published articles only, no sign-in · switch: PUBLIC_MCP_ENABLED, and the SEO agent on</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-fg-muted">
            To connect Claude: Settings › Connectors › Add custom connector, URL <span className="font-mono text-xs">{resourceUrl()}</span>. Claude registers itself, sends you to a consent page on this site, and appears below.
          </p>
        </Card>
      </Section>
      <Section title="Connected clients">
        {grants.length === 0 ? (
          <Empty>No clients connected. Clients appear here after you allow them on the consent page.</Empty>
        ) : (
          <Table head={<tr><th className={th}>Client</th><th className={th}>Scopes</th><th className={th}>Allowed</th><th className={th}>Last used</th><th className={th}>Status</th><th className={th}><span className="sr-only">Actions</span></th></tr>}>
            {grants.map((g) => (
              <tr key={g.id}>
                <td className={td}>{g.client_name}<span className="block font-mono text-xs text-fg-subtle">{g.client_id.slice(0, 16)}…</span></td>
                <td className={`${td} text-xs`}>{g.scopes.map((s) => <span key={s} title={SCOPES[s as keyof typeof SCOPES]} className="mr-1 inline-block rounded bg-surface-sunken px-1.5 py-0.5 font-mono">{s}</span>)}</td>
                <td className={`${td} whitespace-nowrap text-xs`}>{fmtWhen(g.created_at)}<span className="block text-fg-subtle">{g.email}</span></td>
                <td className={`${td} whitespace-nowrap text-xs`}>{g.last_used_at ? fmtWhen(g.last_used_at) : "never"}</td>
                <td className={`${td} text-xs`}>{g.revoked_at ? <>revoked {fmtWhen(g.revoked_at)}</> : "active"}</td>
                <td className={td}>
                  {!g.revoked_at && (
                    <form action={revokeGrant}>
                      <input type="hidden" name="grantId" value={g.id} />
                      <button className="min-h-9 rounded-md border border-line-strong px-3 text-sm font-medium text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-500/10">Revoke</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </>
  );
}
