import { describe, expect, it } from "vitest";
import { callbackPort, orchestrator } from "@/lib/seo-agent/config";

// v5 housekeeping: LangGraph is gone (v4), but existing ConfigMaps may still say SEO_ORCHESTRATOR=langgraph.
// The alias must keep mapping to the CrewAI path, including the callback listener it needs.
describe("SEO_ORCHESTRATOR=langgraph alias", () => {
  it.each(["langgraph", "LangGraph", " langgraph ", "LANGGRAPH"])("%j → crewai", (v) => {
    expect(orchestrator({ SEO_ORCHESTRATOR: v })).toBe("crewai");
    expect(callbackPort({ SEO_ORCHESTRATOR: v })).toBe(9465);
  });

  it("crewai and legacy are unchanged; anything else is legacy", () => {
    expect(orchestrator({ SEO_ORCHESTRATOR: "crewai" })).toBe("crewai");
    expect(orchestrator({ SEO_ORCHESTRATOR: "legacy" })).toBe("legacy");
    expect(orchestrator({ SEO_ORCHESTRATOR: "langchain" })).toBe("legacy");
    expect(orchestrator({})).toBe("legacy");
  });
});
