import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { appRole, duties } from "@/lib/app-role";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));

const { beat, standbyCheck, STANDBY_AFTER_MS, workerSilentMs } = await import("@/lib/worker-heartbeat");

describe("process role (APP_ROLE)", () => {
  it("is all unless it says web or worker", () => {
    expect(appRole({})).toBe("all");
    expect(appRole({ APP_ROLE: "" })).toBe("all");
    expect(appRole({ APP_ROLE: "web" })).toBe("web");
    expect(appRole({ APP_ROLE: " Worker " })).toBe("worker");
    // A typo must not switch the background work off everywhere.
    expect(appRole({ APP_ROLE: "wroker" })).toBe("all");
  });

  it("gives every duty to exactly the roles that should have it", () => {
    expect(duties("all")).toEqual({ backgroundWork: true, standby: false, contentImports: true, serving: true });
    expect(duties("web")).toEqual({ backgroundWork: false, standby: true, contentImports: true, serving: true });
    expect(duties("worker")).toEqual({ backgroundWork: true, standby: false, contentImports: false, serving: false });
    // Between them, a web replica and the worker do everything a single process does.
    for (const duty of ["backgroundWork", "contentImports", "serving"] as const) {
      expect(duties("web")[duty] || duties("worker")[duty]).toBe(duties("all")[duty]);
    }
  });
});

describe("worker heartbeat and web standby", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(() => {
    setDbForTests(undefined);
  });

  const age = (interval: string) => db.execute(sql.raw(`update setting set updated_at = now() - interval '${interval}' where key = 'worker.heartbeat'`));

  it("reports the worker, once, by the database's clock", async () => {
    expect(await workerSilentMs()).toBeNull();
    await beat("worker-1");
    await beat("worker-2");
    const rows = await db.select().from(schema.setting).where(eq(schema.setting.key, "worker.heartbeat"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toEqual({ host: "worker-2" });
    const silent = await workerSilentMs();
    expect(silent).not.toBeNull();
    expect(silent!).toBeGreaterThanOrEqual(0);
    expect(silent!).toBeLessThan(10_000);
    await age("10 minutes");
    expect(await workerSilentMs()).toBeGreaterThan(9 * 60_000);
  });

  it("leaves the work to a worker that is reporting", async () => {
    const start = vi.fn();
    await beat();
    expect(await standbyCheck(start)).toBe(false);
    await age("2 minutes");
    expect(2 * 60_000).toBeLessThan(STANDBY_AFTER_MS);
    expect(await standbyCheck(start)).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("takes the work over when the worker has gone silent, or was never there", async () => {
    const start = vi.fn();
    // No worker has ever reported (APP_ROLE=web without a worker Deployment).
    expect(await standbyCheck(start)).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    await beat();
    await age("4 minutes");
    expect(await standbyCheck(start)).toBe(true);
    expect(start).toHaveBeenCalledTimes(2);
    // The worker is back: a replica that looks now stays out of it.
    await beat();
    expect(await standbyCheck(start)).toBe(false);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
