import { readiness } from "@/lib/crewai/bundle/service";
import { api } from "../../../_lib";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/crewai/config/status (scope crewai:read) — what a deployment checks before it restores the configuration:
 * the database answers, every migration is applied, the SEO agent answers; and the configuration's version, counts,
 * last import (with its Git revision) and drift.
 */
export function GET(request: Request) {
  return api(request, "crewai:read", async () => readiness());
}
