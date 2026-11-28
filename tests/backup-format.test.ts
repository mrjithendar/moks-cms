import { describe, expect, it } from "vitest";
import {
  archiveName,
  canonicalJson,
  classifyEntry,
  fillPlaceholders,
  formatBytes,
  formatSums,
  isSymlinkAttributes,
  manifestSignatureValid,
  parseArchiveName,
  parseSums,
  redactSealed,
  safeObjectKey,
  selectForRetention,
  signManifest,
  siteIdFrom,
  type Manifest,
} from "@/lib/backup/format";
import { seal } from "@/lib/secrets";

/** The pure rules of the site backup format (lib/backup/format.ts, D-108). */

describe("names", () => {
  it("are versioned, sortable and parsed back; nothing else is a backup", () => {
    const at = new Date("2026-11-28T15:49:00Z");
    expect(siteIdFrom("jithendar.com")).toBe("jithendar-com");
    expect(siteIdFrom("www.Example.co.uk")).toBe("example-co-uk");
    const name = archiveName("jithendar-com", "full", at);
    expect(name).toBe("jithendar-com-backup-2026-11-28-154900-full.zip");
    expect(parseArchiveName(name)).toMatchObject({ siteId: "jithendar-com", type: "full", legacy: false, createdAt: at });
    expect(parseArchiveName("jithendar-backup-20261118-210000.zip")).toMatchObject({ type: "legacy", legacy: true });
    for (const bad of ["../jithendar-com-backup-2026-11-28-154900-full.zip", "jithendar-com-backup-2026-11-28-154900-full.zip.json", "x.zip", "jithendar-com-backup-2026-11-28-154900-everything.zip", "jithendar-com-backup-2026-13-99-999999-full.zip"]) {
      expect(parseArchiveName(bad), bad).toBeNull();
    }
  });
});

describe("entry paths (ZIP Slip and anything unexpected)", () => {
  it("accept only the files this format writes", () => {
    expect(classifyEntry("manifest.json")).toEqual({ kind: "manifest" });
    expect(classifyEntry("database/tables/post.jsonl")).toEqual({ kind: "table", table: "post" });
    expect(classifyEntry("uploads/jithendar/www/media/images/2026/11/a.png")).toEqual({ kind: "upload", key: "jithendar/www/media/images/2026/11/a.png" });
    expect(classifyEntry("application/site-files/config/redirects.json")).toEqual({ kind: "application", file: "site-files/config/redirects.json" });
    for (const bad of [
      "../etc/passwd",
      "uploads/../../app/server.js",
      "uploads/jithendar/../../etc/passwd",
      "/etc/passwd",
      "C:/Windows/system32",
      "uploads\\..\\evil",
      "database/tables/post;drop.jsonl",
      "database/tables/../x.jsonl",
      "uploads/jithendar/backups/other.zip",
      "uploads/jithendar/www/tmp/generated/x.png",
      "uploads/elsewhere/x.png",
      "application/../../x",
      "scripts/install.sh",
      "uploads/jithendar/a\u0000b",
    ]) {
      expect("reject" in classifyEntry(bad), bad).toBe(true);
    }
  });

  it("object keys stay under jithendar/, never the backups or the expiring images", () => {
    expect(safeObjectKey("jithendar/www/media/images/2026/11/a.png")).toBe(true);
    expect(safeObjectKey("jithendar/www/site-images/images/logo.png")).toBe(true);
    for (const bad of ["", "other/x", "jithendar/backups/x.zip", "jithendar/www/tmp/x", "jithendar//x", "jithendar/./x", "jithendar/../x", "jithendar/a\nb"]) expect(safeObjectKey(bad), bad).toBe(false);
  });

  it("symbolic links are recognised from the Unix mode bits", () => {
    expect(isSymlinkAttributes((0o120777 << 16) >>> 0)).toBe(true);
    expect(isSymlinkAttributes((0o100644 << 16) >>> 0)).toBe(false);
    expect(isSymlinkAttributes(0)).toBe(false);
  });
});

describe("secrets", () => {
  it("every sealed value becomes a placeholder, whatever writes it (jsonb, JS, Python spacing)", () => {
    const sealed = seal("sk-live-123");
    const jsonb = `{"key": "storage.r2", "value": {"bucket": "media", "secretAccessKey": {"v": 1, "iv": "${sealed.iv}", "tag": "${sealed.tag}", "data": "${sealed.data}"}}}`;
    const js = JSON.stringify({ a: { nested: [sealed, { x: 1 }] } });
    for (const line of [jsonb, js]) {
      const { text, count } = redactSealed(line);
      expect(count).toBeGreaterThan(0);
      expect(text).not.toContain(sealed.data);
      expect(text).toContain('{"$secret": "redacted"}');
      expect(() => JSON.parse(text)).not.toThrow();
    }
    expect(redactSealed('{"v": 2, "iv": "x"}').count).toBe(0);
  });

  it("a restore keeps the site's current credential at the same place, or clears it", () => {
    const now = seal("current");
    const backup = { a: { key: { $secret: "redacted" }, plain: 1 }, list: [{ $secret: "redacted" }] };
    const r = fillPlaceholders(backup, { a: { key: now, plain: 2 }, list: ["not sealed"] });
    expect(r.value).toEqual({ a: { key: now, plain: 1 }, list: [null] });
    expect(r).toMatchObject({ kept: 1, dropped: 1 });
  });
});

describe("manifest signature and checksums", () => {
  const m = { format: "moks-cms-site-backup", formatVersion: 2, name: "x", warnings: [], nested: { b: 1, a: 2 } } as unknown as Omit<Manifest, "signature">;
  it("signs canonical JSON; any change, or another key, breaks it", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    const signed = signManifest(m, "key-one");
    expect(manifestSignatureValid(signed, "key-one")).toBe(true);
    expect(manifestSignatureValid(signed, "key-two")).toBe(false);
    expect(manifestSignatureValid({ ...signed, name: "y" }, "key-one")).toBe(false);
    expect(manifestSignatureValid({ ...signed, signature: undefined }, "key-one")).toBe(false);
    expect(manifestSignatureValid({ ...signed, signature: { ...signed.signature!, value: "zz" } }, "key-one")).toBe(false);
  });

  it("SHA256SUMS is the sha256sum format, both ways; duplicates and junk are refused", () => {
    const sums = new Map([["README.txt", "a".repeat(64)], ["uploads/jithendar/x y.png", "b".repeat(64)]]);
    const text = formatSums(sums);
    expect(text).toBe(`${"a".repeat(64)}  README.txt\n${"b".repeat(64)}  uploads/jithendar/x y.png\n`);
    expect(parseSums(text)).toEqual(sums);
    expect(parseSums(text + text)).toBeNull();
    expect(parseSums("nope  README.txt\n")).toBeNull();
  });
});

describe("retention", () => {
  const day = 86_400_000;
  const now = new Date("2026-11-28T00:00:00Z");
  const b = (name: string, type: "full" | "database" | "prerestore" | "legacy", daysAgo: number) => ({ name, type, createdAt: new Date(now.getTime() - daysAgo * day) });
  const all = [b("f1", "full", 1), b("f2", "full", 2), b("f3", "full", 3), b("d1", "database", 1), b("d2", "database", 40), b("p1", "prerestore", 50), b("old", "legacy", 90)];

  it("keeps the newest N of each type; never old-format backups", () => {
    expect(selectForRetention(all, { keep: 2, maxAgeDays: null, now, protect: new Set() }).sort()).toEqual(["f3"]);
    expect(selectForRetention(all, { keep: 1, maxAgeDays: null, now, protect: new Set() }).sort()).toEqual(["d2", "f2", "f3"]);
  });

  it("drops what is older than the age limit, but never the newest of a type or one in use", () => {
    expect(selectForRetention(all, { keep: 10, maxAgeDays: 30, now, protect: new Set() }).sort()).toEqual(["d2"]);
    expect(selectForRetention(all, { keep: 1, maxAgeDays: 30, now, protect: new Set(["f3", "d2"]) }).sort()).toEqual(["f2"]);
  });
});

it("sizes read in binary units", () => {
  expect([formatBytes(null), formatBytes(0), formatBytes(1536), formatBytes(734_003_200), formatBytes(3 * 1024 ** 3)]).toEqual(["—", "0 B", "1.5 KB", "700 MB", "3.0 GB"]);
});
