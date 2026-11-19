import { describe, expect, it } from "vitest";
import { LEGACY_THEME_KEY, THEME_KEY, themeScript } from "@/components/theme/script";

/** Runs the head script against an in-memory localStorage; returns what is stored after and <html data-theme>. */
function run(defaultMode: "system" | "light" | "dark", initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  };
  const document = { documentElement: { dataset: {} as Record<string, string> } };
  new Function("localStorage", "document", themeScript(defaultMode))(localStorage, document);
  return { stored: Object.fromEntries(data), theme: document.documentElement.dataset.theme };
}

describe("themeScript", () => {
  it("keeps the choice under its own key, never plain theme (Argo CD reads that with JSON.parse)", () => {
    expect(THEME_KEY).not.toBe(LEGACY_THEME_KEY);
    expect(run("system", { [THEME_KEY]: "dark" })).toEqual({ stored: { [THEME_KEY]: "dark" }, theme: "dark" });
  });

  it("moves a bare light/dark from the old key, so Argo CD no longer finds it", () => {
    expect(run("system", { [LEGACY_THEME_KEY]: "light" })).toEqual({ stored: { [THEME_KEY]: "light" }, theme: "light" });
  });

  it("drops a bare old value when a choice is already kept under the new key", () => {
    expect(run("system", { [THEME_KEY]: "dark", [LEGACY_THEME_KEY]: "light" })).toEqual({
      stored: { [THEME_KEY]: "dark" },
      theme: "dark",
    });
  });

  it("leaves Argo CD's own JSON value alone", () => {
    expect(run("system", { [LEGACY_THEME_KEY]: '"dark"' })).toEqual({ stored: { [LEGACY_THEME_KEY]: '"dark"' }, theme: undefined });
  });

  it("applies the site default without a stored choice", () => {
    expect(run("dark", {})).toEqual({ stored: {}, theme: "dark" });
    expect(run("system", {})).toEqual({ stored: {}, theme: undefined });
  });

  it("ignores storage that throws", () => {
    const document = { documentElement: { dataset: {} as Record<string, string> } };
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => new Function("localStorage", "document", themeScript("system"))(blocked, document)).not.toThrow();
  });
});
