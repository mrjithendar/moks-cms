import { describe, expect, it } from "vitest";
import { cleanCrewBody } from "@/lib/seo-intel/handoff";

describe("cleanCrewBody", () => {
  it("keeps a plain body", () => {
    expect(cleanCrewBody("## A\n\nText.")).toBe("## A\n\nText.");
  });

  it("unwraps the reviewer's preamble, ```mdx fence and trailing notes", () => {
    const raw = "## Corrected MDX body\n\nNotes on the edits.\n\n```mdx\nIntro.\n\n## A\n\n```bash\nls\n```\n\nEnd.\n```\n\n## needs_fact_check items\n\n1. claim: why\n";
    expect(cleanCrewBody(raw)).toBe("Intro.\n\n## A\n\n```bash\nls\n```\n\nEnd.");
  });

  it("keeps everything after the opening fence when the wrapper was cut off", () => {
    const raw = "## Corrected MDX body\n\nNotes.\n\n```mdx\nIntro.\n\n```bash\nls\n```\n\n## Command reference";
    expect(cleanCrewBody(raw)).toBe("Intro.\n\n```bash\nls\n```\n\n## Command reference");
  });

  it("drops a bare 'Corrected' heading", () => {
    expect(cleanCrewBody("## Corrected body\n\n## A\n\nText.")).toBe("## A\n\nText.");
  });
});
