import { askState } from "@/lib/seo-agent/ask-settings";
import { AskLauncher } from "./AskLauncher";

/**
 * Server gate: nothing is rendered (and no client code is referenced) unless ASK_BLOG_ENABLED=true, an admin has
 * switched the assistant on, and this placement is ticked (Admin → Automation & AI → Ask the Blog). Pages are cached,
 * so who is signed in is not known here: in signed-in-only mode the launcher asks /api/ask when the reader opens it.
 * A settings read that fails hides the widget rather than failing the page.
 */
export async function AskBlog({ placement }: { placement: "home" | "articles" }) {
  const state = await askState().catch(() => null);
  if (!state?.on || !state.settings.placement[placement]) return null;
  const { copy, audience, limits } = state.settings;
  return <AskLauncher copy={copy} audience={audience} maxQuestion={limits.maxQuestion} />;
}
