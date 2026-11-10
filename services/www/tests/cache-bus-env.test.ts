import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * CACHE_BUS_REDIS_URL is read by the cache bus only. Anything else that picked it up (rate limits, sessions, a new
 * cache) would start storing data in the shared Valkey under an ACL user that is meant for PUBLISH/SUBSCRIBE only,
 * which is exactly what REDIS_URL being absent is meant to prevent. Comments and plain strings may mention it; code
 * may not read it (process.env.X, env.X, env["X"], or destructuring { X } from an env object).
 */
const NAME = "CACHE_BUS_REDIS_URL";
const ROOT = path.resolve(import.meta.dirname, "..");
const ALLOWED = new Set(["src/lib/cache-bus.ts"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) ? [p] : [];
  });
}

function readsOf(source: string, fileName = "x.ts"): number {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  let n = 0;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === NAME) n += 1;
    else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === NAME) n += 1;
    else if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(sf).replace(/["']/g, "") === NAME) n += 1;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

describe(`${NAME} is read by the cache bus only`, () => {
  it("detects every way of reading it", () => {
    expect(readsOf(`process.env.${NAME}`)).toBe(1);
    expect(readsOf(`env["${NAME}"]`)).toBe(1);
    expect(readsOf(`const { ${NAME}: u } = process.env`)).toBe(1);
    expect(readsOf(`const { ${NAME} } = process.env`)).toBe(1);
    expect(readsOf(`// ${NAME}\nconst s = "${NAME} unset";`)).toBe(0);
  });

  it("no module other than src/lib/cache-bus.ts reads it", () => {
    const sources = [...files(path.join(ROOT, "src")), ...files(path.join(ROOT, "scripts")), path.join(ROOT, "next.config.ts")];
    const offenders = sources
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .filter((rel) => !ALLOWED.has(rel) && readsOf(readFileSync(path.join(ROOT, rel), "utf8"), rel) > 0);
    expect(offenders).toEqual([]);
    expect(readsOf(readFileSync(path.join(ROOT, "src/lib/cache-bus.ts"), "utf8"))).toBeGreaterThan(0);
  });
});
