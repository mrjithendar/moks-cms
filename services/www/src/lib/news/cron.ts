/**
 * 5-field cron for the job editor (validation and "next run" display). Same rules as the dispatcher's evaluator
 * (services/seo-agent/app/news/cron.py): lists, ranges, steps, month/day names, 0 and 7 = Sunday, Vixie day rule.
 */
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const ALIASES: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0" };

function num(v: string, names?: Record<string, number>): number {
  const s = v.trim().toLowerCase();
  if (names && s in names) return names[s]!;
  if (!/^\d+$/.test(s)) throw new Error(`"${v}" is not a number`);
  return Number(s);
}

function field(spec: string, lo: number, hi: number, names?: Record<string, number>): { set: Set<number>; restricted: boolean } {
  const out = new Set<number>();
  for (let part of spec.split(",")) {
    let step = 1;
    if (part.includes("/")) {
      const [p, s] = part.split("/", 2) as [string, string];
      if (!/^\d+$/.test(s) || Number(s) < 1) throw new Error(`bad step in "${spec}"`);
      step = Number(s);
      part = p;
    }
    let a: number, b: number;
    if (part === "*") [a, b] = [lo, hi];
    else if (part.includes("-")) {
      const [x, y] = part.split("-", 2) as [string, string];
      [a, b] = [num(x, names), num(y, names)];
    } else {
      a = b = num(part, names);
      if (step > 1) b = hi;
    }
    if (!(lo <= a && a <= hi && lo <= b && b <= hi && a <= b)) throw new Error(`"${spec}" is outside ${lo}-${hi}`);
    for (let i = a; i <= b; i += step) out.add(i);
  }
  return { set: out, restricted: spec !== "*" };
}

type Parsed = { min: Set<number>; hour: Set<number>; dom: { set: Set<number>; restricted: boolean }; month: Set<number>; dow: { set: Set<number>; restricted: boolean }; tz: string };

export function parseCron(expr: string, tz: string): Parsed {
  const e = ALIASES[expr.trim()] ?? expr.trim();
  const parts = e.split(/\s+/);
  if (parts.length !== 5) throw new Error("a cron expression has 5 fields: minute hour day month weekday");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`unknown time zone "${tz}"`);
  }
  const dow = field(parts[4]!, 0, 7, DAYS);
  return { min: field(parts[0]!, 0, 59).set, hour: field(parts[1]!, 0, 23).set, dom: field(parts[2]!, 1, 31), month: field(parts[3]!, 1, 12, MONTHS).set, dow: { set: new Set([...dow.set].map((d) => d % 7)), restricted: dow.restricted }, tz };
}

export function cronError(expr: string, tz: string): string | null {
  try {
    parseCron(expr, tz);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function local(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), wd: WD[p.weekday as string] ?? 0 };
}

export function cronMatches(c: Parsed, d: Date): boolean {
  const l = local(d, c.tz);
  const domOk = c.dom.set.has(l.day);
  const dowOk = c.dow.set.has(l.wd);
  const dayOk = c.dom.restricted && c.dow.restricted ? domOk || dowOk : domOk && dowOk;
  return c.min.has(l.minute) && c.hour.has(l.hour) && c.month.has(l.month) && dayOk;
}

/** Next fire times after `from` (searching up to `days` ahead, minute by minute; fine for the editor). */
export function nextRuns(expr: string, tz: string, from = new Date(), count = 3, days = 8): Date[] {
  const c = parseCron(expr, tz);
  const out: Date[] = [];
  let t = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const end = from.getTime() + days * 86_400_000;
  for (; t < end && out.length < count; t += 60_000) if (cronMatches(c, new Date(t))) out.push(new Date(t));
  return out;
}
