import { describe, expect, it } from "vitest";
import { formatLocal } from "@/components/LocalTime";

describe("formatLocal (timestamps in the viewer's time zone)", () => {
  const iso = "2026-11-10T15:01:56.409Z";
  it("formats in the given zone with its short name", () => {
    expect(formatLocal(iso, "datetime", "UTC")).toBe("10 Nov 2026, 15:01 UTC");
    expect(formatLocal(iso, "datetime", "Asia/Kolkata")).toMatch(/^10 Nov 2026, 20:31 (IST|GMT\+5:30)$/);
    expect(formatLocal(iso, "date", "Asia/Kolkata")).toBe("10 Nov 2026");
    expect(formatLocal(iso, "time", "America/New_York")).toMatch(/^10:01 (EST|GMT-5)$/);
  });
  it("returns the input unchanged when it is not a date", () => {
    expect(formatLocal("not a date")).toBe("not a date");
  });
});
