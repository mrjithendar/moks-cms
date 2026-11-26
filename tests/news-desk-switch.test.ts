import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The news desk's switch (plan P5, PD-7): an admin setting, with NEWS_DESK_ENABLED=false in the deployment as an
 * emergency override. The same rule lives in the seo-agent (seo-agent/app/news/config.py, tests/test_news_*.py).
 */
describe("newsDeskState", () => {
  it("NEWS_DESK_ENABLED=false in the deployment wins over everything", async () => {
    const { newsDeskState, newsDeskStateText } = await import("@/lib/news/schema");
    for (const v of ["false", "0", "off", "no", " FALSE "]) {
      const st = newsDeskState({ enabled: true, paused: false }, { NEWS_DESK_ENABLED: v });
      expect(st).toEqual({ on: false, by: "deployment_off", envValue: "false" });
      expect(newsDeskStateText(st)).toContain("Remove NEWS_DESK_ENABLED");
    }
  });

  it("once the switch is saved the admin decides, whatever the deployment says (short of false)", async () => {
    const { newsDeskState } = await import("@/lib/news/schema");
    expect(newsDeskState({ enabled: true, paused: false }, {})).toMatchObject({ on: true, by: "admin", envValue: "unset" });
    expect(newsDeskState({ enabled: false, paused: false }, {})).toMatchObject({ on: false, by: "admin" });
    expect(newsDeskState({ enabled: false, paused: false }, { NEWS_DESK_ENABLED: "true" })).toMatchObject({ on: false, by: "admin", envValue: "true" });
    expect(newsDeskState({ enabled: true, paused: true }, {})).toMatchObject({ on: false, by: "admin" }); // an old pause is still honoured
  });

  it("never saved: the deployment's true keeps the desk on as before, anything else is off", async () => {
    const { newsDeskState, newsSettingsSchema } = await import("@/lib/news/schema");
    const never = newsSettingsSchema.parse({});
    expect(never.enabled).toBeUndefined(); // nothing is preset: an unsaved row has no switch value
    expect(newsDeskState(never, { NEWS_DESK_ENABLED: "true" })).toMatchObject({ on: true, by: "deployment_legacy" });
    expect(newsDeskState({ ...never, paused: true }, { NEWS_DESK_ENABLED: "true" })).toMatchObject({ on: false, by: "deployment_legacy" });
    expect(newsDeskState(never, {})).toMatchObject({ on: false, by: "default", envValue: "unset" });
    expect(newsDeskState(never, { NEWS_DESK_ENABLED: "maybe" })).toMatchObject({ on: false, by: "default", envValue: "unset" });
    expect(newsDeskState(null, { NEWS_DESK_ENABLED: "true" })).toMatchObject({ on: true }); // settings unreadable: as before
    expect(newsDeskState(null, {})).toMatchObject({ on: false });
  });

  it("the settings row accepts the switch and stays strict", async () => {
    const { newsSettingsSchema } = await import("@/lib/news/schema");
    expect(newsSettingsSchema.parse({ enabled: true }).enabled).toBe(true);
    expect(newsSettingsSchema.safeParse({ enabled: "yes" }).success).toBe(false);
    expect(newsSettingsSchema.safeParse({ switched_on: true }).success).toBe(false);
  });
});
