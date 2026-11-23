import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(path.resolve(import.meta.dirname, "..", f), "utf8");

/**
 * Owner, 2026-11-21: every settings page looks like Settings → General: the sections listed on the left (a select on
 * a phone), one section at a time, the open one in the address (?section=<id>). components/admin/SettingsSections.
 */
describe("settings pages share the sectioned layout of Settings → General", () => {
  const PAGES: [file: string, basePath: string, sections: string[]][] = [
    ["src/app/admin/integrations/page.tsx", "BACK", ["social", "turnstile", "indexnow", "verification", "analytics", "search-console", "gemini", "image-limits", "video-generation"]],
    ["src/app/admin/storage/page.tsx", "BACK", ["media", "video-destinations", "move"]],
    ["src/app/admin/email/page.tsx", "", ["provider", "test"]],
  ];

  it.each(PAGES)("%s", (file, basePath, sections) => {
    const src = read(file);
    expect(src).toContain("<SettingsSections");
    expect(src).toContain(basePath ? `basePath={${basePath}}` : 'basePath="/admin/email"');
    for (const id of sections) expect(src, id).toContain(`id: "${id}"`);
    expect(src, "no jump-link strip left: one section at a time").not.toMatch(/href=\{`#\$\{x\.id\}`\}/);
  });

  it("a save comes back to the section it was made in", () => {
    const integrations = read("src/app/admin/integrations/page.tsx");
    for (const s of ["social", "gemini", "indexnow"]) expect(integrations).toContain(`flash(backTo("${s}")`);
    const storage = read("src/app/admin/storage/page.tsx");
    expect(storage).toContain("flash(`${BACK}?section=media`");
    expect(storage).toContain("flash(`${BACK}?section=move`");
  });

  it("MCP access is part of AI & SEO → Settings → MCP; its old page sends you to the connected clients", () => {
    expect(read("src/app/admin/(growth)/automation/sections/index.ts")).toContain('{ id: "mcp", label: "MCP", group: "Assistants", render: McpSection }');
    expect(read("src/app/admin/(growth)/automation/mcp/page.tsx")).toContain('redirect(aiSeoSectionHref("mcp", "mcp-clients-h"))');
    expect(read("src/app/admin/(growth)/automation/sections/mcp.tsx")).toContain('<Section title="Connected clients" id="mcp-clients">');
  });
});
