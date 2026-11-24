import { count, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { AdminSidebar } from "@/components/admin/AdminNav";
import { SessionGuard } from "@/components/SessionGuard";
import { Alert } from "@/components/ui/form";
import { getDb, schema } from "@/db";
import { reviewCount } from "@/lib/admin-bar-server";
import { NAV_PREFS_COOKIE, readNavPrefs, type NavItem } from "@/lib/admin-menu";
import { moderationCounts } from "@/lib/comments";
import { menuForModules, moduleStates } from "@/lib/modules";
import { requireRole } from "@/lib/session";
import { SignOutButton } from "../account/SignOutButton";
// The admin stylesheet (search, analytics and calendar components are part of the CMS, so it loads on every admin page).
import "./(growth)/seo.css";

export const metadata: Metadata = { title: { default: "Admin", template: "%s · Admin" }, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireRole("admin", "author");
  const db = await getDb();
  const isAdmin = user.role === "admin";
  const [comments, [unread], review, jar, modules] = await Promise.all([
    moderationCounts(),
    db.select({ n: count() }).from(schema.contactMessage).where(eq(schema.contactMessage.status, "new")),
    isAdmin ? reviewCount(db) : 0,
    cookies(),
    // Which optional modules are set up (lib/modules.ts): AI & SEO is drawn only while the SEO agent is.
    isAdmin ? moduleStates().catch(() => []) : [],
  ]);
  // One CMS (D-86): search, analytics, the editorial calendar and AI drafting are ordinary admin pages.
  // This list says which pages this person may open and what their badges count. Where each page sits in the menu
  // (its group, order and short name) is in lib/admin-menu.ts; `section` is only the group of a page that file does
  // not know yet.
  const items: NavItem[] = [
    { href: "/admin", label: "Dashboard", section: "Overview" },
    { href: "/admin/user-manual", label: "User manual", section: "Overview" },
    // Content: what is published.
    { href: "/admin/posts", label: "Posts", section: "Content" },
    { href: "/admin/posts/new", label: "New post", section: "Content" },
    { href: "/admin/pages", label: "Pages", section: "Content" },
    { href: "/admin/pages/new", label: "New page", section: "Content" },
    { href: "/admin/media", label: "Media", section: "Content" },
    { href: "/admin/categories", label: "Categories", section: "Content" },
    { href: "/admin/tags", label: "Tags", section: "Content" },
    { href: "/admin/practice", label: "Python practice", section: "Content" },
    // Editorial & AI: planning and AI-drafted work waiting for a person.
    ...(isAdmin
      ? [
          { href: "/admin/calendar", label: "Editorial calendar", section: "Editorial & AI" },
          { href: "/admin/review", label: "Review queue", badge: review, section: "Editorial & AI" },
          { href: "/admin/promotion", label: "Promotion", section: "Editorial & AI" },
        ]
      : []),
    // Insights: search and audience data.
    ...(isAdmin
      ? [
          { href: "/admin/search", label: "Search performance", section: "Insights" },
          { href: "/admin/analytics", label: "Visitor analytics", section: "Insights" },
          { href: "/admin/page-insights", label: "Page insights", section: "Insights" },
          { href: "/admin/content/sources", label: "Content sources", section: "Insights" },
          { href: "/admin/content/topics", label: "Content topics", section: "Insights" },
          { href: "/admin/content/profiles", label: "Content profiles & playground", section: "Insights" },
          { href: "/admin/content/analytics", label: "Content analytics", section: "Insights" },
          { href: "/admin/keywords", label: "Keywords", section: "Insights" },
          { href: "/admin/recommendations", label: "Recommendations", section: "Insights" },
          { href: "/admin/content-audit", label: "Content audit", section: "Insights" },
          { href: "/admin/links", label: "Internal linking", section: "Insights" },
          { href: "/admin/backlinks", label: "Backlinks", section: "Insights" },
          { href: "/admin/ai-visibility", label: "AI visibility", section: "Insights" },
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
          { href: "/admin/invoices", label: "Invoices", section: "Community" },
          // The /hire-me page is built in (not under Pages); its settings are a section of Appearance.
          { href: "/admin/appearance?section=hireMe", label: "Hire me page", section: "Community" },
        ]
      : []),
    // Site settings and operations (admins only).
    ...(isAdmin
      ? [
          { href: "/admin/appearance", label: "Appearance & settings", section: "Site settings" },
          // Sections of Appearance & settings that people look for by name.
          { href: "/admin/appearance?section=navigation", label: "Menus", section: "Site settings" },
          { href: "/admin/appearance?section=homepage", label: "Homepage", section: "Site settings" },
          { href: "/admin/appearance?section=theme", label: "Typography & colours", section: "Site settings" },
          { href: "/admin/appearance?section=general", label: "General settings", section: "Site settings" },
          { href: "/admin/integrations", label: "Integrations", section: "Site settings" },
          { href: "/admin/crewai", label: "CrewAI console", section: "Site settings" },
          { href: "/admin/crewai/flows", label: "Flows", section: "Site settings" },
          { href: "/admin/crewai/runs", label: "Flow runs", section: "Site settings" },
          { href: "/admin/crewai/crews", label: "Crews", section: "Site settings" },
          { href: "/admin/crewai/categories", label: "Crew and flow categories", section: "Site settings" },
          { href: "/admin/crewai/config", label: "CrewAI import / export", section: "Site settings" },
          { href: "/admin/automation", label: "AI & SEO settings", section: "Site settings" },
          { href: "/admin/automation?section=mcp", label: "MCP", section: "Site settings" },
          { href: "/admin/automation/skills", label: "Skills", section: "Site settings" },
          { href: "/admin/storage", label: "Storage", section: "Site settings" },
          { href: "/admin/email", label: "Email", section: "Site settings" },
          { href: "/admin/users", label: "Users", section: "Site settings" },
          { href: "/admin/system", label: "System status", section: "Operations" },
          { href: "/admin/cache", label: "Cache", section: "Operations" },
          { href: "/admin/sync", label: "Data sync", section: "Operations" },
          { href: "/admin/models", label: "ML models", section: "Operations" },
          { href: "/admin/backups", label: "Backups", section: "Operations" },
          { href: "/admin/database", label: "Database", section: "Operations" },
          { href: "/admin/lancedb", label: "LanceDB", section: "Operations" },
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
    <div data-admin-shell className="min-h-[calc(100dvh-var(--spacing-chrome))] bg-surface-muted md:grid md:grid-cols-[auto_minmax(0,1fr)]">
      {/* The sidebar is the first column and as wide as it draws itself: full, or icons only (components/admin/AdminNav.tsx). */}
      <AdminSidebar items={menuForModules(items, modules)} role={user.demo ? "demo" : user.role} account={account} prefs={readNavPrefs(jar.get(NAV_PREFS_COOKIE)?.value)} />
      <div className="min-w-0 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <div className="mx-auto max-w-6xl">
          {user.demo && (
            <div data-demo-banner className="mb-6">
              <Alert tone="info">
                <strong>Read-only demo.</strong> You see the admin exactly as the site owner does, but nothing you change is saved and nothing is sent.{" "}
                New here? Start with the <Link href="/admin/user-manual" className="link">User manual</Link>.
              </Alert>
            </div>
          )}
          {children}
        </div>
      </div>
      <SessionGuard userId={user.id} />
    </div>
  );
}
