import { askState, type AskSettings } from "@/lib/seo-agent/ask-settings";
import { AskDock } from "./AskDock";
import { AskLauncher } from "./AskLauncher";
import { askHiddenOn, type AskClientConfig } from "./types";

/** Only what the widget needs: never the budget, the limits beyond the question length, or anything else server-side. */
function clientConfig(s: AskSettings): AskClientConfig {
  return { copy: s.copy, audience: s.audience, maxQuestion: s.limits.maxQuestion, conversation: s.conversation };
}

/** Where each inline card lives, to tell whether the sitewide launcher is there to open (an admin may hide it). */
const PLACEMENT_PATH = { home: "/", articles: "/blog/x" } as const;

/**
 * Server gate for the inline card: nothing is rendered (and no client code is referenced) unless ASK_BLOG_ENABLED=true,
 * an admin has switched the assistant on, and this card is ticked (Admin → Automation & AI → Ask the Blog). With the
 * sitewide chat on, the card opens the corner panel; on a path where an admin hid the launcher it expands in place.
 * Pages are cached, so who is signed in is not known here: in signed-in-only mode the widget asks /api/ask when the
 * reader opens it. A settings read that fails hides the widget rather than failing the page.
 */
export async function AskBlog({ placement }: { placement: "home" | "articles" }) {
  const state = await askState().catch(() => null);
  if (!state?.on || !state.settings.placement[placement]) return null;
  const { sitewide } = state.settings;
  const opener = sitewide.enabled && !askHiddenOn(PLACEMENT_PATH[placement], sitewide.hideOn);
  return <AskLauncher config={clientConfig(state.settings)} mode={opener ? "opener" : "inline"} />;
}

/**
 * Server gate for the sitewide chat (root layout): the corner launcher on every public page, when the assistant is on
 * and Admin → Ask the Blog → "Show the chat on every page" is ticked. Hidden paths are applied in the client
 * (AskDock), because the layout is shared by every route and does not know the path. Saving the settings revalidates
 * the layout.
 */
export async function AskSitewide() {
  const state = await askState().catch(() => null);
  if (!state?.on || !state.settings.sitewide.enabled) return null;
  const { sitewide } = state.settings;
  return <AskDock config={clientConfig(state.settings)} launcher={sitewide.launcher} hideOn={sitewide.hideOn} />;
}
