"use server";

import type { ReactNode } from "react";
import { mdxComponents } from "@/components/Mdx";
import { collections, type Collection } from "@/config/taxonomy";
import { getPublishedArticle } from "@/lib/content";
import { log } from "@/lib/log";
import { compileMdx } from "@/lib/mdx/compile";
import { previewPercentFor, sitePreviewPercent, splitForMembers } from "@/lib/members";
import { getSessionUser } from "@/lib/session";

/**
 * The members-only part of an article, rendered on the server with the same components as the public page.
 * The reader comes from the session cookie (never from the arguments): signed-out readers get `signin` and no
 * content. The public page itself only ever contains the preview (lib/members.ts).
 */
export type MembersContent = { ok: true; content: ReactNode } | { ok: false; reason: "signin" | "unavailable" };

export async function loadMembersContent(collection: string, slug: string): Promise<MembersContent> {
  if (!(collections as readonly string[]).includes(collection) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return { ok: false, reason: "unavailable" };
  const user = await getSessionUser();
  if (!user) return { ok: false, reason: "signin" };
  try {
    const article = await getPublishedArticle(collection as Collection, slug);
    if (!article?.frontmatter.membersOnly) return { ok: false, reason: "unavailable" };
    const site = sitePreviewPercent(await (await import("@/lib/runtime-settings")).effectiveEnv());
    const { rest } = splitForMembers(article.body, previewPercentFor(article.frontmatter.previewPercent, site));
    if (!rest) return { ok: false, reason: "unavailable" };
    const { Content } = await compileMdx(rest);
    return { ok: true, content: <Content components={mdxComponents} /> };
  } catch (err) {
    log.error("members content failed", { collection, slug, err });
    return { ok: false, reason: "unavailable" };
  }
}
