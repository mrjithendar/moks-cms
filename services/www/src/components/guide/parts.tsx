import Link from "next/link";
import type { GuideEntry } from "@/lib/user-guide";
import type { SettingsGroup } from "@/lib/user-guide-settings";

/**
 * Pieces of the user manual shared by its home page (GuideBrowser, in the browser) and its article and print pages
 * (rendered on the server): an entry's text, its diagram, the link to the admin page it describes and a settings table.
 * No state and no hooks, so both sides can use them.
 */

/** An entry's paragraphs; consecutive lines starting with "- " become one list. */
export function GuideBody({ lines, className = "mt-3" }: { lines: string[]; className?: string }) {
  const blocks: (string | string[])[] = [];
  for (const line of lines) {
    if (line.startsWith("- ")) {
      const last = blocks.at(-1);
      if (Array.isArray(last)) last.push(line.slice(2));
      else blocks.push([line.slice(2)]);
    } else blocks.push(line);
  }
  return (
    <div className={`${className} space-y-3 text-sm leading-6 text-fg-muted`}>
      {blocks.map((b, i) =>
        Array.isArray(b) ? (
          <ul key={i} className="list-disc space-y-1 pl-5">
            {b.map((li) => <li key={li}>{li}</li>)}
          </ul>
        ) : (
          <p key={i}>{b}</p>
        ),
      )}
    </div>
  );
}

/** In the admin, a link to the page an entry describes; on the public manual only its path is named. */
export function GuidePageLink({ href, linkToAdmin }: { href?: string; linkToAdmin: boolean }) {
  if (!href) return null;
  return linkToAdmin ? (
    <Link href={href} className="link mt-3 inline-block text-sm font-medium">Open this page →</Link>
  ) : (
    <p className="mt-3 text-xs text-fg-subtle">In the admin: <span className="font-mono">{href}</span></p>
  );
}

/** `eager`: load the image at once (article and print pages), so it is there when the page is printed. */
export function GuideDiagram({ d, eager = false }: { d: NonNullable<GuideEntry["diagram"]>; eager?: boolean }) {
  const src = `/guide/${d.name}.drawio.svg`;
  return (
    <figure className="mt-4">
      {/* The SVG carries its draw.io source: open it in draw.io (app.diagrams.net) to edit. */}
      <a href={src} target="_blank" rel="noopener" className="block overflow-x-auto rounded-lg border border-line bg-white p-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- static SVG, no optimisation needed */}
        <img src={src} alt={d.alt} loading={eager ? "eager" : "lazy"} className="h-auto min-w-[640px] max-w-full" />
      </a>
      <figcaption className="mt-1 text-xs text-fg-subtle">Diagram (draw.io). Select it to open full size.</figcaption>
    </figure>
  );
}

/** One settings group as a table: the setting, what it does and its default (never a value saved on a site). */
export function SettingsTable({ group }: { group: SettingsGroup }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="text-xs text-fg-subtle">
            <th className="py-2 pr-4 font-semibold">Setting</th>
            <th className="py-2 pr-4 font-semibold">What it does</th>
            <th className="py-2 font-semibold">Default</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {group.rows.map((r) => (
            <tr key={`${r.key ?? ""}${r.name}`} className="align-top">
              <td className="py-2 pr-4 font-medium text-fg">
                {r.name}
                {r.key && <span className="mt-0.5 block font-mono text-xs font-normal text-fg-subtle">{r.key}</span>}
              </td>
              <td className="py-2 pr-4 text-fg-muted">{r.help ?? "—"}</td>
              <td className="py-2 font-mono text-xs text-fg-muted">{r.default ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
