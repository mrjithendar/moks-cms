"use client";

import { useEffect } from "react";

/**
 * Table-of-contents scroll-spy (~1 KB, no dependencies): marks the TOC link of the section being read with
 * aria-current="location". Progressive enhancement only — the TOC works without it.
 */
export function ScrollSpy() {
  useEffect(() => {
    // Targets come from the TOC links already in the page (no id list in the HTML payload).
    const ids = [...new Set([...document.querySelectorAll<HTMLAnchorElement>('nav a[href^="#"]')].map((a) => decodeURIComponent(a.hash.slice(1))))];
    const heads = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => Boolean(e));
    if (!heads.length || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const mark = () => {
      // The first visible heading, else the last one scrolled past.
      const current = heads.find((h) => visible.has(h.id))?.id ?? [...heads].reverse().find((h) => h.getBoundingClientRect().top < 120)?.id;
      for (const a of document.querySelectorAll<HTMLAnchorElement>('nav a[href^="#"]')) {
        if (a.getAttribute("href") === `#${current}`) a.setAttribute("aria-current", "location");
        else if (a.getAttribute("aria-current") === "location") a.removeAttribute("aria-current");
      }
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        mark();
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    for (const h of heads) io.observe(h);
    return () => io.disconnect();
  }, []);
  return null;
}
