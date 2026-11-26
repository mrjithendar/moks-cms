import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(path.resolve(import.meta.dirname, "..", f), "utf8");

/**
 * Owner, 2026-11-21: every settings page looks alike (sections listed on the left, a select on a phone, one section at
 * a time in the address). Owner, 2026-11-26: and they are all in one place, the Settings area
 * (app/admin/settings/[category]/page.tsx, components/admin/SettingsHub). The behaviour is tested in
 * settings-area.test.tsx and settings-sections.test.tsx; these check the wiring in the source.
 */
describe("the Settings area's sections", () => {
  it("a save comes back to the section it was made in", () => {
    const back: [file: string, section: string][] = [
      ["social.tsx", "social"],
      ["gemini.tsx", "gemini"],
      ["indexnow.tsx", "indexnow"],
      ["rag.tsx", "rag"],
      ["storage.tsx", "media-storage"],
      ["storage.tsx", "move-media"],
      ["backups.tsx", "backups"],
      ["practice.tsx", "practice"],
      ["invoices.tsx", "invoices"],
    ];
    for (const [file, section] of back) expect(read(`src/app/admin/settings/sections/${file}`), `${file} → ${section}`).toContain(`flash(settingsHref("${section}")`);
    expect(read("src/app/admin/settings/sections/email-actions.ts")).toContain('revalidatePath(settingsCategoryHref("email"))');
  });

  it("each section starts with the same heading (name, what it does, its state)", () => {
    for (const f of ["social.tsx", "gemini.tsx", "indexnow.tsx", "storage.tsx", "email.tsx", "invoices.tsx", "practice.tsx", "promotion.tsx", "backups.tsx", "agent-extras.tsx", "seo-agent.tsx", "general.tsx"]) {
      expect(read(`src/app/admin/settings/sections/${f}`), f).toContain("<SectionHeading");
    }
    expect(read("src/components/admin/RuntimeSettings.tsx")).toContain('layout === "section"');
  });

  it("MCP access is Settings → Assistants → MCP; its old page sends you to the connected clients", () => {
    expect(read("src/app/admin/(growth)/automation/sections/index.ts")).toContain("mcp: McpSection,");
    expect(read("src/app/admin/(growth)/automation/mcp/page.tsx")).toContain('redirect(settingsHref("mcp", "mcp-clients-h"))');
    expect(read("src/app/admin/(growth)/automation/sections/mcp.tsx")).toContain('<Section title="Connected clients" id="mcp-clients">');
  });

  it("feature pages keep their records and link to their settings instead of drawing them", () => {
    const pages: [file: string, section: string][] = [
      ["src/app/admin/users/page.tsx", "members"],
      ["src/app/admin/payments/page.tsx", "razorpay"],
      ["src/app/admin/bookings/page.tsx", "calcom"],
      ["src/app/admin/practice/page.tsx", "practice"],
      ["src/app/admin/backups/page.tsx", "backups"],
      ["src/app/admin/(growth)/content/sources/page.tsx", "content-fetching"],
    ];
    for (const [file, section] of pages) expect(read(file), file).toContain(`<SettingsElsewhere href={settingsHref("${section}")}>`);
    expect(read("src/app/admin/cache/page.tsx")).toContain('settingsHref("cloudflare")');
    expect(read("src/app/admin/(growth)/promotion/page.tsx")).toContain('if (sp.tab === "settings") redirect(settingsHref("promotion"));');
    expect(read("src/app/admin/crewai/config/page.tsx")).toContain('if (sp.tab === "settings") redirect(settingsHref("crewai-repository"));');
  });
});
