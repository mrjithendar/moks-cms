import { authorMetadata, AuthorProfilePage } from "@/lib/pages/author";
import { resolvePage } from "@/lib/pages/listing";
import { authorListing } from "@/lib/pages/listings";

type Props = { params: Promise<{ slug: string; n: string }> };

// ISR (lib/page-cache.ts): rendered once, served from the page cache, re-rendered after 300 s (PAGE_REVALIDATE_SECONDS)
// and cleared on every replica when content or settings change.
export const revalidate = 300;
// No paths at build time (the build has no database): each one is rendered on its first request, then cached.
export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: Props) {
  const { slug, n } = await params;
  return authorMetadata(slug, resolvePage(await authorListing(slug), n).page);
}

export default async function Page({ params }: Props) {
  const { slug, n } = await params;
  return <AuthorProfilePage slug={slug} paged={resolvePage(await authorListing(slug), n)} />;
}
