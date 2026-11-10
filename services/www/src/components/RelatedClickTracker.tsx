"use client";

import { useEffect } from "react";
import { track } from "@/lib/analytics";

/**
 * GA4 event for the v5 related-articles A/B experiment (docs/seo/ML.md "Related articles"): `related_click` with the
 * arm ("model" | "rule") and the card position. Sent through the site's consent-aware gtag only (nothing without
 * consent or GA4). Click-through rate = related_click / article page views per arm.
 */
export function RelatedClickTracker({ targetId, arm }: { targetId: string; arm: "model" | "rule" }) {
  useEffect(() => {
    const el = document.getElementById(targetId);
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest("a[href]");
      if (!link || !el.contains(link)) return;
      const items = [...el.querySelectorAll("li")];
      const li = link.closest("li");
      track("related_click", { arm, position: li ? items.indexOf(li) + 1 : 0 });
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [targetId, arm]);
  return null;
}
