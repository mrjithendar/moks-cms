/** JSON calls to /api/admin/crewai/config/*: the body or a readable error (with the server's issues). */
export type ApiError = { error?: string; issues?: string[]; reference?: string; plan?: unknown };

export class CallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: ApiError,
  ) {
    super(message);
  }
}

export async function call<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? "GET", headers: init.body === undefined ? undefined : { "Content-Type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body), cache: "no-store" });
  } catch {
    throw new CallError("Network error.", 0, {});
  }
  const data = (await res.json().catch(() => ({}))) as ApiError & T;
  if (!res.ok) throw new CallError([data.error ?? `Error ${res.status}.`, ...(data.issues ?? []).slice(0, 12)].join(" · ") + (data.reference ? ` (ref ${data.reference})` : ""), res.status, data);
  return data;
}

export const BASE = "/api/admin/crewai/config";
