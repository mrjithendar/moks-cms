import { describe, expect, it } from "vitest";
import { cleanCrewBody, uniqueNotes } from "@/lib/seo-intel/handoff";

describe("uniqueNotes", () => {
  // From a real draft: the SEO editor's copy of each claim first, then the reviewer's with the formatting it kept.
  const w = (message: string) => ({ severity: "warning", message });
  const notes = [
    w("Boot chain (UEFI/BIOS -> GRUB 2 -> kernel + initramfs -> PID 1 systemd -> default target in dependency order) and the mermaid diagram built on it: Only source is the interview-prep guide."),
    w("ps -eo pid,stat,wchan:20,cmd | awk '$2 ~ /^D/': ps(1) not retrievable; the command has not been run."),
    { severity: "error", message: "/blog/devops-interview-preparation-guide is published: It is a draft with TODO comments. Confirm it is published before linking." },
    w("Process states R/S/D/Z/T and their meanings: Not verified against ps(1)."),
    w("Boot chain (UEFI/BIOS → GRUB 2 → kernel + initramfs → PID 1 systemd → default target in dependency order), and the mermaid diagram built on it: Only source is the interview-prep guide."),
    w("`ps -eo pid,stat,wchan:20,cmd \\: awk '$2 ~ /^D/'` | ps(1) not retrievable; the command has not been run."),
    w("`/blog/devops-interview-preparation-guide` is published: It is a draft with TODO comments."),
  ];

  it("lists a claim once whatever its formatting, keeping the fuller note and the error", () => {
    expect(uniqueNotes(notes)).toEqual([notes[0], notes[1], notes[2], notes[3]]);
  });

  it("keeps different claims that only share leading words", () => {
    const pair = [w("ps: not verified."), w("pstree: not verified."), w("ps -ef: not verified.")];
    expect(uniqueNotes(pair)).toEqual(pair);
  });

  it("upgrades a kept warning when its duplicate is an error", () => {
    expect(uniqueNotes([w("`x` is set: why"), { severity: "error", message: "x is set: why" }])).toEqual([{ severity: "error", message: "`x` is set: why" }]);
  });
});

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
