import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maintenanceState, resetMaintenanceCache, type Maintenance } from "@/lib/site-config/maintenance";

const OFF: Maintenance = { enabled: false, message: "", retryAfterMinutes: 30 };
const ON: Maintenance = { enabled: true, message: "Back soon", retryAfterMinutes: 15 };
/** Let the promise chain of a background refresh settle. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => resetMaintenanceCache());
afterEach(() => vi.useRealTimers());

describe("maintenance state (read by the proxy on every public request)", () => {
  it("waits for the first read, then answers from memory for 10 seconds", async () => {
    const load = vi.fn(async () => ON);
    const t0 = Date.now();
    expect(await maintenanceState(t0, load)).toEqual(ON);
    expect(await maintenanceState(t0 + 9_000, load)).toEqual(ON);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("after 10 seconds answers the stored value at once and refreshes once in the background", async () => {
    let value = OFF;
    let release: (() => void) | undefined;
    const load = vi.fn(async () => {
      if (load.mock.calls.length > 1) await new Promise<void>((r) => (release = r)); // the refresh hangs until released
      return value;
    });
    const t0 = Date.now();
    expect(await maintenanceState(t0, load)).toEqual(OFF);

    value = ON;
    // Five requests arrive after the TTL while the database is slow: none waits, and only one read is running.
    const answers = await Promise.all(Array.from({ length: 5 }, () => maintenanceState(t0 + 11_000, load)));
    expect(answers).toEqual([OFF, OFF, OFF, OFF, OFF]);
    expect(load).toHaveBeenCalledTimes(2);

    release!();
    await settle();
    expect(await maintenanceState(Date.now(), load)).toEqual(ON);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps the last known state when the database is unavailable, without throwing", async () => {
    const t0 = Date.now();
    expect(await maintenanceState(t0, async () => ON)).toEqual(ON);
    const failing = vi.fn(async (): Promise<Maintenance> => {
      throw new Error("connection refused");
    });
    expect(await maintenanceState(t0 + 11_000, failing)).toEqual(ON);
    await settle();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(await maintenanceState(Date.now(), failing)).toEqual(ON); // still answered, and no second read inside the TTL
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("a first read that fails means: not in maintenance", async () => {
    expect(
      await maintenanceState(Date.now(), async () => {
        throw new Error("connection refused");
      }),
    ).toEqual(OFF);
  });

  it("never holds the first request longer than 1.5 s when the database does not answer", async () => {
    vi.useFakeTimers();
    const never = vi.fn(() => new Promise<Maintenance>(() => undefined));
    const pending = maintenanceState(Date.now(), never);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await pending).toEqual(OFF);
    expect(never).toHaveBeenCalledTimes(1);
  });
});
