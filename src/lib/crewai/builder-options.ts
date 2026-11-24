import "server-only";
import type { CrewOption, FlowOption } from "@/components/crewai/CustomFlowEditor";
import type { AgentCrew, AgentFlow } from "@/lib/seo-agent/client";
import { allItems } from "./catalog";

/**
 * What the flow builder offers (components/crewai/CustomFlowEditor.tsx): every crew, with the inputs it takes (a spec
 * crew's input schema; a code crew's placeholders, as the agent runs it in a step), and every flow a step may start
 * (not approval-only, not a runner; the agent says which: flow_step), with its inputs from its input model.
 */
export async function builderOptions(agentCrews: AgentCrew[] | null, agentFlows: Map<string, AgentFlow> | null): Promise<{ crews: CrewOption[]; flows: FlowOption[] }> {
  const [crews, flows] = await Promise.all([allItems("crew"), allItems("flow")]);
  const codeInputs = new Map((agentCrews ?? []).map((c) => [c.crew, [...new Set(c.tasks.flatMap((t) => t.variables))].filter((v) => v !== "today").map((name) => ({ name }))]));
  const crewOptions: CrewOption[] = crews.map((c) => ({
    key: c.key,
    label: c.label,
    enabled: c.enabled,
    inputs:
      c.definition === "spec"
        ? (((c.spec?.inputs as unknown[]) ?? []).map((i) => (typeof i === "string" ? { name: i } : (i as { name: string; required?: boolean; description?: string }))))
        : (codeInputs.get(c.key) ?? []),
  }));
  const flowOptions: FlowOption[] = flows
    .filter((f) => f.definition === "code" && f.flowName && f.start !== "approval" && (agentFlows?.get(f.flowName)?.flow_step ?? true))
    .map((f) => {
      const schema = agentFlows?.get(f.flowName!)?.inputs_schema;
      const required = new Set(schema?.required ?? []);
      return { name: f.flowName!, label: f.label, inputs: Object.keys(schema?.properties ?? {}).map((name) => ({ name, required: required.has(name) })) };
    });
  return { crews: crewOptions, flows: flowOptions };
}
