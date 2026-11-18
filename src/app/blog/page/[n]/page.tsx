import { listingMetadata, ListingPage, resolvePage, type PageParams } from "@/lib/pages/listing";
import { collectionListing } from "@/lib/pages/listings";

// ISR (lib/page-cache.ts): rendered once, served from the page cache, re-rendered after 300 s (PAGE_REVALIDATE_SECONDS)
// and cleared on every replica when content or settings change.
export const revalidate = 300;
// No paths at build time (the build has no database): each one is rendered on its first request, then cached.
export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: PageParams) {
  const listing = await collectionListing("blog");
  return listingMetadata(listing, resolvePage(listing, (await params).n).page);
}

export default async function Page({ params }: PageParams) {
  const listing = await collectionListing("blog");
  return <ListingPage listing={listing} paged={resolvePage(listing, (await params).n)} />;
}
