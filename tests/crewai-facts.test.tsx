import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

const { Facts, factLabel } = await import("@/components/crewai/Facts");
const { StepInspector } = await import("@/components/crewai/StepInspector");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("Facts: a run's inputs and outputs without JSON", () => {
  it("turns field names into labels", () => {
    expect(factLabel("performance_rows")).toBe("Performance rows");
    expect(factLabel("rag_api_url")).toBe("RAG API URL");
    expect(factLabel("by_type")).toBe("By type");
    expect(factLabel("gsc_performance")).toBe("GSC performance");
    expect(factLabel("triggeredBy")).toBe("Triggered by");
  });

  it("shows seo_intel_sync_flow's outputs as labelled values, plain ones first", () => {
    const outputs = {
      result: { chunks: 112, by_type: { gsc_performance: 39, keyword_cluster: 57 }, deleted: 0, ingested: 96, documents: 96, unchanged: 0, cluster_rows: 163, performance_rows: 1221, rag_api_url: "http://rag-api.rag.svc.cluster.local:8000", collection: "seo_intel" },
      outcome: "synced",
    };
    const t = text(renderToStaticMarkup(<Facts value={outputs} />));
    expect(t).not.toMatch(/[{}"]/);
    expect(t.startsWith("Outcome synced Result")).toBe(true);
    expect(t).toContain("Ingested 96");
    expect(t).toContain("Performance rows 1,221");
    expect(t).toContain("RAG API URL http://rag-api.rag.svc.cluster.local:8000");
    expect(t).toContain("By type GSC performance 39 Keyword cluster 57");
  });

  it("reads booleans, lists and empty values", () => {
    expect(text(renderToStaticMarkup(<Facts value={{ full: true }} />))).toBe("Full Yes");
    expect(text(renderToStaticMarkup(<Facts value={{ models: ["decay", "intent"], slot: null, tags: [] }} />))).toBe("Slot — Models decay, intent Tags none");
    expect(text(renderToStaticMarkup(<Facts value={{}} empty="No inputs: the flow's defaults." />))).toBe("No inputs: the flow's defaults.");
    const many = Array.from({ length: 30 }, (_, i) => `d${i}`);
    expect(text(renderToStaticMarkup(<Facts value={{ doc_ids: many }} />))).toMatch(/d24, and 5 more$/);
  });

  it("lists a step's own facts in the step inspector", () => {
    const step = { id: 1, seq: 1, step: "collect", status: "succeeded", seconds: 0.1, error: null, detail: { performance_rows: 221, documents: 96, collection: "seo_intel", seconds: 0.1 }, startedAt: "2026-11-26T14:23:59Z", finishedAt: "2026-11-26T14:23:59Z" };
    const t = text(renderToStaticMarkup(<StepInspector steps={[step as never]} />));
    expect(t).toContain("Performance rows 221");
    expect(t).toContain("Collection seo_intel");
    expect(t).not.toContain("Seconds");
  });
});
