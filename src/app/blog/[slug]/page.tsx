import { articleMetadata, ArticlePage, type SlugParams } from "@/lib/pages/article";

// Drafts and future items never render (getPublishedContent).
// ISR (lib/page-cache.ts): rendered once, served from the page cache, re-rendered after 300 s (PAGE_REVALIDATE_SECONDS)
// and cleared on every replica when content or settings change.
export const revalidate = 300;
// No paths at build time (the build has no database): each one is rendered on its first request, then cached.
export async function generateStaticParams() {
  return [];
}

export const generateMetadata = (props: SlugParams) => articleMetadata("blog", props);

export default function Page(props: SlugParams) {
  return <ArticlePage collection="blog" {...props} />;
}
