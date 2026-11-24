import { exportFiles } from "@/lib/crewai/bundle/service";
import { api } from "../../_lib";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/crewai/config (scope crewai:read) — the complete CrewAI configuration bundle as files ({path: text}), with
 * the export report (counts, what is not covered and why, what was redacted). What `scripts/crewconfig.py pull` in the
 * site repository writes to crewconfig/. No secrets.
 */
export function GET(request: Request) {
  return api(request, "crewai:read", async () => {
    const { files, manifest, report } = await exportFiles();
    return { kind: manifest.kind, format: manifest.format, files, report };
  });
}
