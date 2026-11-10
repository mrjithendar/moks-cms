import { askEnabled } from "@/lib/seo-agent/config";
import { AskLauncher } from "./AskLauncher";

/** Server gate: nothing is rendered (and no client code is referenced) unless ASK_BLOG_ENABLED=true. */
export function AskBlog() {
  if (!askEnabled()) return null;
  return <AskLauncher />;
}
