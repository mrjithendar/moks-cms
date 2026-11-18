import { describe, expect, it } from "vitest";
import { callbackPort, orchestratorSetting } from "@/lib/seo-agent/config";

// v5 housekeeping: LangGraph is gone (v4), but existing ConfigMaps may still say SEO_ORCHESTRATOR=langgraph.
// The alias must keep forcing the CrewAI path, including the callback listener it needs.
describe("SEO_ORCHESTRATOR=langgraph alias", () => {
  it.each(["langgraph", "LangGraph", " langgraph ", "LANGGRAPH"])("%j → crewai", (v) => {
    expect(orchestratorSetting({ SEO_ORCHESTRATOR: v })).toBe("crewai");
    expect(callbackPort({ SEO_ORCHESTRATOR: v })).toBe(9465);
  });

  it("crewai and legacy force either way; anything else (or nothing) means find the agent", () => {
    expect(orchestratorSetting({ SEO_ORCHESTRATOR: "crewai" })).toBe("crewai");
    expect(orchestratorSetting({ SEO_ORCHESTRATOR: "legacy" })).toBe("legacy");
    expect(orchestratorSetting({ SEO_ORCHESTRATOR: "langchain" })).toBe("auto");
    expect(orchestratorSetting({})).toBe("auto");
  });
});
