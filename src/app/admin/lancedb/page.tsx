import { redirect } from "next/navigation";

// LanceDB was removed (D-103): it only held a copy of the article index that nothing searched. The index itself is in
// pgvector, browsed at AI & SEO → Article index. Kept so old bookmarks land somewhere useful.
export default function LanceDbPage() {
  redirect("/admin/article-index");
}
