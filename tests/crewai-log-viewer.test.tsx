// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { refresh: () => {} }; // one object, like Next's: the stream effect depends on it
vi.mock("next/navigation", () => ({ useRouter: () => router }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A stand-in for the browser's EventSource: the test plays the server's events. */
class FakeSource {
  static all: FakeSource[] = [];
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  closed = false;
  constructor(public url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  send(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

const { LogViewer } = await import("@/components/crewai/LogViewer");

const RUN = "4131b86e-6b1d-414f-bfd0-07f7ac63795b";
const line = (id: number, message: string) => ({ id, step: "ingest", level: "info", logger: "seo_agent.seo_intel", event: null, message, context: {}, at: "2026-11-26T14:25:00Z" });

describe("LogViewer: a run's live log", () => {
  let root: Root;
  let el: HTMLDivElement;
  beforeEach(() => {
    FakeSource.all = [];
    vi.stubGlobal("EventSource", FakeSource);
    el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
  });
  afterEach(() => {
    act(() => root.unmount());
    el.remove();
    vi.unstubAllGlobals();
  });

  it("carries on in a new stream from the last line when the server ends one while the run is still going", () => {
    const steps = [{ step: "ingest", status: "running", seconds: null, error: null, count: 1 }];
    act(() => root.render(<LogViewer runId={RUN} initial={[line(1, "Sending 96 documents")]} live steps={steps} runStatus="running" hasMore={false} />));
    expect(FakeSource.all.map((s) => s.url)).toEqual([`/api/admin/crewai/runs/${RUN}/logs?after=1`]);
    const first = FakeSource.all[0]!;
    act(() => {
      first.send("log", line(2, "[1/96] keyword_cluster:a (new)"));
      first.send("status", { status: "running" });
      first.send("end", {}); // the server's ~5-minute window
    });
    expect(first.closed).toBe(true);
    expect(FakeSource.all.map((s) => s.url)).toEqual([`/api/admin/crewai/runs/${RUN}/logs?after=1`, `/api/admin/crewai/runs/${RUN}/logs?after=2`]);
    const second = FakeSource.all[1]!;
    act(() => {
      second.send("log", line(3, "[2/96] keyword_cluster:b (new)"));
      second.send("status", { status: "succeeded" });
      second.send("end", {}); // the run finished: no third stream
    });
    expect(FakeSource.all).toHaveLength(2);
    act(() => [...el.querySelectorAll("button")].find((b) => b.textContent === "Expand all")?.click());
    expect(el.textContent).toContain("[2/96] keyword_cluster:b (new)");
  });
});
