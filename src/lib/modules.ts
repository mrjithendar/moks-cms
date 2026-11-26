import "server-only";
import { agentStatus, type AgentStatus, type EndpointDeps } from "@/lib/seo-agent/endpoint";
import { MENU_PLACES, type NavItem } from "@/lib/admin-menu";
import { settingsHref } from "@/lib/settings-areas";

/**
 * Optional modules of the admin and whether this deployment has them (D-100). The admin menu, the module's pages and
 * GET /api/admin/capabilities all ask `moduleStates()`, so nothing decides by a hard-coded flag whether a module's
 * menu is drawn.
 *
 * One module today, the SEO agent (seo-agent/, the same image run as a second container, D-105): AI & SEO is its menu. It is
 * - installed when an endpoint is set for it (SEO_AGENT_URL, or the one saved under Settings → SEO agent) or one was
 *   found by discovery and answers, and SEO_ORCHESTRATOR is not "legacy";
 * - available when it answers now (lib/seo-agent/endpoint.ts agentStatus, cached 30–60 s per process).
 * The menu follows `installed`, so an agent that is set up but briefly down keeps its menu (its pages then say the agent
 * is off and keep their history readable); an agent that is not set up has no menu, and its pages say how to set it up
 * instead of rendering empty.
 */
export type ModuleId = "seo-agent";
export type ModuleState = {
  id: ModuleId;
  label: string;
  /** Set up here: its menu and pages are shown. */
  installed: boolean;
  /** Answers now. */
  available: boolean;
  version: string | null;
  reason: string;
  /** The admin menu groups (lib/admin-menu.ts MENU_GROUPS) the module owns. */
  menuGroups: string[];
  /** Where an admin sets it up when it is not installed. */
  setupHref: string;
};

type ModuleDef = { id: ModuleId; label: string; menuGroups: string[]; setupHref: string; detect: (deps: ModuleDeps) => Promise<Pick<ModuleState, "installed" | "available" | "version" | "reason">> };
export type ModuleDeps = { agent?: EndpointDeps; status?: () => Promise<AgentStatus> };

export const SEO_AGENT_SETUP = settingsHref("seo-agent");

export function seoAgentInstalled(s: AgentStatus): boolean {
  if (s.mode === "forced off") return false;
  return s.enabled || s.source === "env" || s.source === "admin";
}

const MODULES: ModuleDef[] = [
  {
    id: "seo-agent",
    label: "SEO agent",
    menuGroups: ["ai"],
    setupHref: SEO_AGENT_SETUP,
    detect: async (deps) => {
      let s: AgentStatus;
      try {
        s = deps.status ? await deps.status() : await agentStatus(deps.agent ?? {});
      } catch {
        return { installed: false, available: false, version: null, reason: "The SEO agent could not be checked." };
      }
      return { installed: seoAgentInstalled(s), available: s.enabled, version: s.version, reason: s.reason };
    },
  },
];

/** Every module and its state. */
export async function moduleStates(deps: ModuleDeps = {}): Promise<ModuleState[]> {
  return Promise.all(MODULES.map(async (m) => ({ id: m.id, label: m.label, menuGroups: m.menuGroups, setupHref: m.setupHref, ...(await m.detect(deps)) })));
}

export async function moduleState(id: ModuleId, deps: ModuleDeps = {}): Promise<ModuleState> {
  return (await moduleStates(deps)).find((m) => m.id === id)!;
}

const GROUP_OF = new Map(MENU_PLACES.map(([href, p]) => [href, p.group]));

/** The menu items without those of modules that are not installed. */
export function menuForModules(items: NavItem[], states: ModuleState[]): NavItem[] {
  const hidden = new Set(states.filter((m) => !m.installed).flatMap((m) => m.menuGroups));
  if (hidden.size === 0) return items;
  return items.filter((i) => !hidden.has(GROUP_OF.get(i.href) ?? ""));
}

/** The module a page belongs to (by its menu group), if any: its layout shows the set-up notice when it is missing. */
export function moduleOfPath(pathname: string): ModuleId | null {
  let best: { len: number; group: string } | null = null;
  for (const [href, p] of MENU_PLACES) {
    const path = href.split("?")[0]!;
    if ((pathname === path || pathname.startsWith(`${path}/`)) && path.length > (best?.len ?? 0)) best = { len: path.length, group: p.group };
  }
  return (best && MODULES.find((m) => m.menuGroups.includes(best!.group))?.id) ?? null;
}
