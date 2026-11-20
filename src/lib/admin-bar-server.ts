import "server-only";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/db/rows";
import { barTarget, type AdminBarData, type BarLink, type BarPreference } from "./admin-bar";
import { moderationCounts } from "./comments";
import type { SessionUser } from "./session";

type Db = Awaited<ReturnType<typeof getDb>>;

/** AI drafts waiting for a person (the Review queue badge). 0 when the SEO tables do not exist yet. */
export async function reviewCount(db: Db): Promise<number> {
  try {
    const [r] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_drafts where status = 'ready_for_review'`));
    return Number(r?.n ?? 0);
  } catch {
    return 0;
  }
}

function live(row: { status: string; publishedAt: Date | null; deletedAt: Date | null }, now: number): boolean {
  return row.status === "published" && !!row.publishedAt && row.publishedAt.getTime() <= now && !row.deletedAt;
}

/**
 * The bar's links about the page being viewed. Every link is only a shortcut: the page it opens checks the role
 * again. Authors get "Edit" only for their own posts (lib/posts.ts canTouch), admins for everything.
 */
export async function contextLinks(db: Db, user: Pick<SessionUser, "id" | "role">, pathname: string, now = Date.now()): Promise<BarLink[]> {
  const admin = user.role === "admin";
  const t = barTarget(pathname);
  switch (t.kind) {
    case "home":
      return admin ? [{ label: "Customize homepage", href: "/admin/appearance?section=homepage" }] : [];
    case "post": {
      const [row] = await db
        .select({ id: schema.post.id, authorId: schema.post.authorId })
        .from(schema.post)
        .where(and(eq(schema.post.collection, t.collection), eq(schema.post.slug, t.slug), isNull(schema.post.deletedAt)));
      if (!row || (!admin && row.authorId !== user.id)) return [];
      const label = t.collection === "news" ? "Edit news story" : t.collection === "projects" ? "Edit project" : "Edit post";
      return [{ label, href: `/admin/posts/${row.id}` }, ...(admin ? [{ label: "Post insights", href: `/admin/posts/${row.id}/insights` }] : [])];
    }
    case "page": {
      const [row] = await db.select({ slug: schema.page.slug }).from(schema.page).where(and(eq(schema.page.slug, t.slug), isNull(schema.page.deletedAt)));
      return row ? [{ label: "Edit page", href: `/admin/pages/${encodeURIComponent(row.slug)}` }] : [];
    }
    case "category":
      return admin ? [{ label: "Edit categories", href: "/admin/categories" }] : [];
    case "tag":
      return admin ? [{ label: "Edit tags", href: "/admin/tags" }] : [];
    case "author": {
      const [profile] = await db.select({ userId: schema.authorProfile.userId }).from(schema.authorProfile).where(eq(schema.authorProfile.slug, t.slug));
      if (profile?.userId === user.id) return [{ label: "Edit your profile", href: "/admin/profile" }];
      return admin ? [{ label: "Manage users", href: "/admin/users" }] : [];
    }
    case "listing":
      return [{ label: t.collection === "news" ? "All news" : t.collection === "projects" ? "All projects" : "All posts", href: `/admin/posts?collection=${t.collection}` }];
    case "hire-me":
      return admin ? [{ label: "Edit Hire me page", href: "/admin/appearance?section=hireMe" }] : [];
    case "admin-post": {
      const [row] = await db
        .select({ collection: schema.post.collection, slug: schema.post.slug, status: schema.post.status, publishedAt: schema.post.publishedAt, deletedAt: schema.post.deletedAt })
        .from(schema.post)
        .where(eq(schema.post.id, t.id));
      return row && live(row, now) ? [{ label: row.collection === "news" ? "View news story" : row.collection === "projects" ? "View project" : "View post", href: `/${row.collection}/${row.slug}` }] : [];
    }
    case "admin-page": {
      const [row] = await db.select({ slug: schema.page.slug }).from(schema.page).where(and(eq(schema.page.slug, t.slug), isNull(schema.page.deletedAt)));
      return row ? [{ label: "View page", href: `/${row.slug}` }] : [];
    }
    default:
      return [];
  }
}

/** Everything GET /api/admin/bar returns, for a staff member (admin, author, or the read-only demo). */
export async function adminBarData(user: SessionUser, pathname: string, preference: BarPreference): Promise<AdminBarData> {
  const db = await getDb();
  const admin = user.role === "admin";
  const [comments, messages, review, context] = await Promise.all([
    moderationCounts(),
    admin ? db.select({ n: count() }).from(schema.contactMessage).where(eq(schema.contactMessage.status, "new")).then(([r]) => Number(r?.n ?? 0)) : 0,
    admin ? reviewCount(db) : 0,
    contextLinks(db, user, pathname),
  ]);
  return {
    user: { name: user.name, email: user.email, image: user.image, role: admin ? "admin" : "author", demo: Boolean(user.demo) },
    badges: { comments: comments.pending + comments.reported, messages, review },
    context,
    cache: admin ? { allowed: !user.demo } : null,
    preference,
  };
}
