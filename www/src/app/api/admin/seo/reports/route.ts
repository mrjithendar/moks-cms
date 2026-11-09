import { json, seoRoute } from "@/lib/seo-intel/http";
import { listReports } from "@/lib/seo-intel/reports";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/reports — generated weekly and monthly reports. */
export const GET = seoRoute("reports", {}, async () => json({ reports: await listReports() }));
