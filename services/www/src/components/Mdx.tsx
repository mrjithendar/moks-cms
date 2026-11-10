import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { isProductionEnv } from "@/config/site";
import { linkRel } from "@/lib/mdx/link-rel";
import type { MDXComponents } from "mdx/types";
import { CodeBlock } from "./CodeBlock";
import { ContentImage } from "./ContentImage";
import { ContentAudio, ContentVideo } from "./ContentMedia";

/** Owner placeholder for facts that cannot be verified from the repo. Hidden in production builds. */
function Todo({ children }: { children?: ReactNode }) {
  if (isProductionEnv()) return null;
  return (
    <span className="rounded border border-amber-400 bg-amber-50 px-1 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
      TODO(owner): {children}
    </span>
  );
}

/**
 * Body links (owner decisions 2026-11-10): every external link is rel="nofollow noopener" (src/lib/mdx/link-rel.ts),
 * and every link except an in-page #fragment opens in a new tab, announced to screen readers.
 */
function Anchor({ href = "", rel, children, ...props }: ComponentProps<"a">) {
  if (href.startsWith("#")) return <a href={href} rel={rel} {...props}>{children}</a>;
  const newTab = <span className="sr-only"> (opens in a new tab)</span>;
  if (href.startsWith("/") && !href.startsWith("//")) {
    return <Link href={href} target="_blank" rel={rel ? `${rel} noopener` : "noopener"} {...props}>{children}{newTab}</Link>;
  }
  return <a href={href} target="_blank" rel={linkRel(href, rel) ?? "noopener"} {...props}>{children}{newTab}</a>;
}

export const mdxComponents: MDXComponents = {
  a: Anchor,
  pre: CodeBlock,
  img: ContentImage,
  video: ContentVideo,
  audio: ContentAudio,
  Todo,
};
