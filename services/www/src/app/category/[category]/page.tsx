import { listingMetadata, ListingPage, resolvePage } from "@/lib/pages/listing";
import { categoryListing } from "@/lib/pages/listings";

type Props = { params: Promise<{ category: string }> };

// ISR (lib/page-cache.ts): rendered once, served from the page cache, re-rendered after 300 s (PAGE_REVALIDATE_SECONDS)
// and cleared on every replica when content or settings change.
export const revalidate = 300;
// No paths at build time (the build has no database): each one is rendered on its first request, then cached.
export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: Props) {
  return listingMetadata(await categoryListing((await params).category));
}

export default async function Page({ params }: Props) {
  const listing = await categoryListing((await params).category);
  return <ListingPage listing={listing} paged={resolvePage(listing)} />;
}
