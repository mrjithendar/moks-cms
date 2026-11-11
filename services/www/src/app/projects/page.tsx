import { listingMetadata, ListingPage, resolvePage } from "@/lib/pages/listing";
import { collectionListing } from "@/lib/pages/listings";

// ISR (lib/page-cache.ts): rendered once, served from the page cache, re-rendered after 300 s (PAGE_REVALIDATE_SECONDS)
// and cleared on every replica when content or settings change.
export const revalidate = 300;

export const generateMetadata = async () => listingMetadata(await collectionListing("projects"));

export default async function Page() {
  const listing = await collectionListing("projects");
  return <ListingPage listing={listing} paged={resolvePage(listing)} />;
}
