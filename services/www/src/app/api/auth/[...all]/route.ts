import { getAuth } from "@/lib/auth";
import { auditAuthResponse, emailFromRequest } from "@/lib/auth-audit";
import { withClientIp } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

async function handle(incoming: Request) {
  // Rate limits and the session's address use the visitor's address as our proxies report it, never a header the
  // client can set (lib/client-ip.ts).
  const request = withClientIp(incoming);
  const path = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
  const email = await emailFromRequest(request, path);
  const response = await (await getAuth()).handler(request);
  // Failed, blocked and sensitive requests go to the audit log (Admin → Audit log). Never fails the request.
  await auditAuthResponse({ path, method: request.method, request, response, email });
  return response;
}

export { handle as GET, handle as POST };
