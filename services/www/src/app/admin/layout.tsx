import { count, eq, sql } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AdminNav, type NavItem } from "@/components/admin/AdminNav";
import { SessionGuard } from "@/components/SessionGuard";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/db/rows";
import { moderationCounts } from "@/lib/comments";
import { requireRole } from "@/lib/session";
import { SignOutButton } from "../account/SignOutButton";
// The admin stylesheet (search, analytics and calendar components are part of the CMS, so it loads on every admin page).
import "./(growth)/seo.css";

export const metadata: Metadata = { title: { default: "Admin", template: "%s · Admin" }, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function reviewCount(db: Awaited<ReturnType<typeof getDb>>): Promise<number> {
  try {
    const [r] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_drafts where status = 'ready_for_review'`));
    return Number(r?.n ?? 0);
  } catch {
    return 0;
  }
}

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireRole("admin", "author");
  const db = await getDb();
  const isAdmin = user.role === "admin";
  const [comments, [unread], review] = await Promise.all([
    moderationCounts(),
    db.select({ n: count() }).from(schema.contactMessage).where(eq(schema.contactMessage.status, "new")),
    isAdmin ? reviewCount(db) : 0,
  ]);
  // One CMS (D-86): search, analytics, the editorial calendar and AI drafting are ordinary admin pages.
  // Grouped by category; each category expands and collapses in the sidebar (components/admin/AdminNav.tsx).
  const items: NavItem[] = [
    { href: "/admin", label: "Dashboard", section: "Overview" },
    // Content: what is published.
    { href: "/admin/posts", label: "Posts", section: "Content" },
    { href: "/admin/pages", label: "Pages", section: "Content" },
    { href: "/admin/media", label: "Media", section: "Content" },
    { href: "/admin/categories", label: "Categories", section: "Content" },
    { href: "/admin/tags", label: "Tags", section: "Content" },
    { href: "/admin/practice", label: "Python practice", section: "Content" },
    // Editorial & AI: planning and AI-drafted work waiting for a person.
    ...(isAdmin
      ? [
          { href: "/admin/calendar", label: "Editorial calendar", section: "Editorial & AI" },
          { href: "/admin/review", label: "Review queue", badge: review, section: "Editorial & AI" },
          { href: "/admin/news", label: "News desk", section: "Editorial & AI" },
          { href: "/admin/promotion", label: "Promotion", section: "Editorial & AI" },
        ]
      : []),
    // Insights: search and audience data.
    ...(isAdmin
      ? [
          { href: "/admin/search", label: "Search performance", section: "Insights" },
          { href: "/admin/analytics", label: "Visitor analytics", section: "Insights" },
          { href: "/admin/page-insights", label: "Page insights", section: "Insights" },
          { href: "/admin/keywords", label: "Keywords", section: "Insights" },
          { href: "/admin/recommendations", label: "Recommendations", section: "Insights" },
          { href: "/admin/content-audit", label: "Content audit", section: "Insights" },
          { href: "/admin/links", label: "Internal linking", section: "Insights" },
          { href: "/admin/backlinks", label: "Backlinks", section: "Insights" },
          { href: "/admin/technical", label: "Technical health", section: "Insights" },
          { href: "/admin/reports", label: "Reports", section: "Insights" },
        ]
      : []),
    // Community: people who write to you or book a call.
    { href: "/admin/comments", label: "Comments", badge: comments.pending + comments.reported, section: "Community" },
    ...(isAdmin
      ? [
          { href: "/admin/messages", label: "Messages", badge: unread?.n, section: "Community" },
          { href: "/admin/bookings", label: "Bookings", section: "Community" },
          { href: "/admin/payments", label: "Payments", section: "Community" },
          // The /hire-me page is built in (not under Pages); its settings are a section of Appearance.
          { href: "/admin/appearance?section=hireMe", label: "Hire me page", section: "Community" },
        ]
      : []),
    // Site settings and operations (admins only).
    ...(isAdmin
      ? [
          { href: "/admin/appearance", label: "Appearance & settings", section: "Site settings" },
          { href: "/admin/integrations", label: "Integrations", section: "Site settings" },
          { href: "/admin/automation", label: "Automation & AI", section: "Site settings" },
          { href: "/admin/automation/mcp", label: "MCP access", section: "Site settings" },
          { href: "/admin/advanced", label: "Advanced settings", section: "Site settings" },
          { href: "/admin/storage", label: "Storage & email", section: "Site settings" },
          { href: "/admin/users", label: "Users", section: "Site settings" },
          { href: "/admin/system", label: "System status", section: "Operations" },
          { href: "/admin/sync", label: "Data sync", section: "Operations" },
          { href: "/admin/models", label: "ML models", section: "Operations" },
          { href: "/admin/backups", label: "Backups", section: "Operations" },
          { href: "/admin/database", label: "Database", section: "Operations" },
          { href: "/admin/audit", label: "Audit log", section: "Operations" },
        ]
      : []),
    { href: "/admin/profile", label: "Author profile", section: "Account" },
    { href: "/admin/api-keys", label: "API keys", section: "Account" },
  ];

  const account = (
    <>
      <p className="truncate font-medium text-fg" title={user.name}>{user.name}</p>
      <p className="truncate text-fg-subtle" title={user.email}>{user.email}</p>
      <SignOutButton className="mt-3" />
    </>
  );

  return (
    <div data-admin-shell className="min-h-[calc(100dvh-var(--spacing-header))] bg-surface-muted lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="border-b border-line bg-canvas lg:sticky lg:top-header lg:h-[calc(100dvh-var(--spacing-header))] lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <div className="flex flex-col gap-3 px-4 py-3 sm:px-6 lg:min-h-full lg:gap-6 lg:px-4 lg:py-6">
          <Link href="/admin" className="hidden items-center gap-2 px-3 lg:flex">
            <span className="text-sm font-semibold text-fg">Admin</span>
            <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-medium capitalize text-fg-muted">{user.role}</span>
          </Link>
          <AdminNav items={items} account={<div className="text-sm">{account}</div>} />
          <div className="mt-auto hidden border-t border-line px-3 pt-4 text-sm lg:block">{account}</div>
        </div>
      </aside>
      <div className="min-w-0 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <div className="mx-auto max-w-6xl">{children}</div>
      </div>
      <SessionGuard userId={user.id} />
    </div>
  );
}
