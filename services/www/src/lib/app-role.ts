/**
 * What this process is for (APP_ROLE). The same image runs as:
 *
 * - `all` (default, and any unknown value): serves requests and runs the background work. One process, as the site
 *   ran until the worker pod existed, and how it runs locally and in tests.
 * - `web`: serves requests. Background work is left to the worker, with this replica on standby
 *   (lib/worker-heartbeat.ts).
 * - `worker`: runs the background work (scheduled publishing, the job queue, backups). It still answers the health
 *   probes, but no Service points at it.
 */
export type AppRole = "all" | "web" | "worker";

export function appRole(env: Record<string, string | undefined> = process.env): AppRole {
  const value = (env.APP_ROLE ?? "").trim().toLowerCase();
  return value === "web" || value === "worker" ? value : "all";
}

/** What instrumentation.ts starts for a role. */
export function duties(role: AppRole) {
  return {
    /** Scheduled publishing, the job queue, backups: started at boot, and reported by a heartbeat. */
    backgroundWork: role !== "web",
    /** Watch the worker's heartbeat and start the background work here if it stops. */
    standby: role === "web",
    /**
     * Start-up imports that read content/ (practice catalog, bundled posts). Not on the worker: content releases
     * restart only the web Deployment, so the worker's copy can be older and must not be written back.
     */
    contentImports: role !== "worker",
    /** The seo-agent callback listener and cache warm-up, which only matter where requests arrive. */
    serving: role !== "worker",
  };
}
