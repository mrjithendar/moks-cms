import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, schema } from "@/db";
import { actorOf } from "@/lib/admin";
import { getCategories } from "@/lib/categories";
import { imageGenerationStatus } from "@/lib/image-generation";
import { rowToForm } from "@/lib/post-form";
import { getPostRow, PostError } from "@/lib/posts";
import { getAutosave } from "@/lib/revisions";
import { crewNotesForPost, handOffForPost } from "@/lib/seo-intel/handoff";
import { requireRole } from "@/lib/session";
import { PostEditor } from "../PostEditor";

export const metadata = { title: "Edit post" };

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRole("admin", "author");
  const actor = actorOf(user);
  const { id } = await params;
  // A finished editorial-calendar draft moves into this post before it is loaded (idempotent; never overwrites edits).
  await handOffForPost(id);
  const row = await getPostRow(actor, id).catch((e) => {
    if (e instanceof PostError) notFound();
    throw e;
  });
  if (row.deletedAt) notFound();
  const db = await getDb();
  const [categories, imageGeneration, autosave, [author], notes] = await Promise.all([
    getCategories(),
    imageGenerationStatus(),
    getAutosave(actor, "post", id),
    db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, row.authorId)),
    row.status === "published" ? null : crewNotesForPost(id),
  ]);
  return (
    <>
      {user.role === "admin" && (
        <p className="mb-3 text-right text-sm">
          <Link className="underline" href={`/admin/posts/${row.id}/insights`}>Search insights and AI proposals</Link>
        </p>
      )}
      {notes && (notes.incomplete || notes.flags.length > 0) && (
        <details open className="mb-4 rounded-lg border border-amber-600/30 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-400/10 dark:text-amber-100">
          <summary className="cursor-pointer font-medium">AI draft notes: check these before publishing ({notes.flags.length + (notes.incomplete ? 1 : 0)})</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {notes.incomplete && <li><strong>Incomplete:</strong> {notes.incomplete}. Finish the missing sections here.</li>}
            {notes.flags.map((f, i) => <li key={i}>{f.severity === "error" ? <strong>Must fix: </strong> : null}{f.message}</li>)}
          </ul>
        </details>
      )}
      <PostEditor
        id={row.id}
        initial={rowToForm(row)}
        version={row.version}
        autosaved={autosave ? { value: rowToForm(autosave.payload), savedAt: autosave.savedAt.toISOString(), baseVersion: autosave.baseVersion } : null}
        userId={user.id}
        authorName={author?.name ?? "Unknown"}
        categories={categories}
          imageGeneration={imageGeneration}
      />
    </>
  );
}
