/**
 * Generates the site style guide Claude drafts against, from the articles themselves (measured, not invented):
 * heading case and depth, first-person usage, sentence and paragraph length, code-fence conventions, lists/tables,
 * spelling variant, and a few short verbatim openings as tone examples.
 *
 *   npx tsx scripts/seo-style-guide.ts            # bundled MDX in content/ (blog + news)
 *   CONTENT_DIR=/path npx tsx scripts/seo-style-guide.ts
 *
 * Writes docs/seo/STYLE_GUIDE.md (for people) and src/lib/seo-intel/style-guide.ts (the same text, imported by the
 * draft prompt, because docs/ is not in the runtime image). Re-run after the site's voice changes.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const root = process.env.CONTENT_DIR ?? "content";
const files = ["blog", "news"].flatMap((c) => (fs.existsSync(path.join(root, c)) ? fs.readdirSync(path.join(root, c)).filter((f) => f.endsWith(".mdx")).map((f) => path.join(root, c, f)) : []));
type Doc = { collection: string; title: string; description: string; body: string };
const docs: Doc[] = files.map((f) => {
  const raw = fs.readFileSync(f, "utf8");
  const end = raw.indexOf("\n---", 4);
  const fm = YAML.parse(raw.slice(4, end)) as Record<string, string>;
  return { collection: path.basename(path.dirname(f)), title: fm.title ?? "", description: fm.description ?? "", body: raw.slice(end + 4) };
});
if (!docs.length) {
  console.error(`No articles found under ${root}/blog or ${root}/news.`);
  process.exit(1);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const prose = (b: string) => b.replace(/(```|~~~)[\s\S]*?\1/g, "").replace(/^\s*[|:].*$/gm, "");
const wordsOf = (s: string) => s.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];

let headings = 0;
let sentenceCase = 0;
let h2 = 0;
let h3 = 0;
let h4 = 0;
let questionHeadings = 0;
let fences = 0;
let fencesWithLang = 0;
let fencesWithTitle = 0;
const langs = new Map<string, number>();
let totalWords = 0;
let firstPersonI = 0;
let firstPersonWe = 0;
let secondPerson = 0;
const sentenceLens: number[] = [];
const paraLens: number[] = [];
let lists = 0;
let tables = 0;
let directives = 0;
let british = 0;
let american = 0;
let emDash = 0;
let oxford = 0;
const titleLens = docs.map((d) => d.title.length);
const descLens = docs.map((d) => d.description.length);

for (const d of docs) {
  for (const m of d.body.matchAll(/^(#{2,4})\s+(.+)$/gm)) {
    headings++;
    const level = m[1]!.length;
    if (level === 2) h2++;
    else if (level === 3) h3++;
    else h4++;
    const words = m[2]!.replace(/`[^`]*`/g, "x").split(/\s+/).slice(1).filter((w) => /^[A-Za-z]/.test(w) && w.length > 3);
    if (words.length === 0 || words.filter((w) => /^[A-Z][a-z]/.test(w)).length / words.length < 0.5) sentenceCase++;
    if (m[2]!.trim().endsWith("?")) questionHeadings++;
  }
  for (const m of d.body.matchAll(/^\s*(```|~~~)([^\n]*)$/gm)) {
    const info = m[2]!.trim();
    if (!info && fences % 2 === 1) {
      fences++;
      continue; // closing fence
    }
    fences++;
    if (info) {
      fencesWithLang++;
      const lang = info.split(/\s+/)[0]!.toLowerCase();
      langs.set(lang, (langs.get(lang) ?? 0) + 1);
      if (/title=|filename=/.test(info)) fencesWithTitle++;
    }
  }
  const p = prose(d.body);
  const w = wordsOf(p);
  totalWords += w.length;
  firstPersonI += (p.match(/\b(I|I'm|I’ve|I've|I’d|my|me)\b/g) ?? []).length;
  firstPersonWe += (p.match(/\b(we|we're|our|us)\b/gi) ?? []).length;
  secondPerson += (p.match(/\b(you|your|you're)\b/gi) ?? []).length;
  for (const para of p.split(/\n{2,}/)) {
    const t = para.trim();
    if (!t || /^(#|[-*+] |\d+\. |>|!\[|<|\|)/.test(t)) continue;
    paraLens.push(wordsOf(t).length);
    for (const s of t.split(/(?<=[.!?])\s+(?=[A-Z])/)) if (wordsOf(s).length > 2) sentenceLens.push(wordsOf(s).length);
  }
  lists += (d.body.match(/^(\s*)([-*+]|\d+\.)\s/gm) ?? []).length;
  tables += (d.body.match(/^\|.*\|\s*\n\|\s*:?-{3,}/gm) ?? []).length;
  directives += (d.body.match(/^:::\w+/gm) ?? []).length;
  british += (p.match(/\b\w+(ise|ised|ising|isation|our)\b/gi) ?? []).filter((x) => /(optimis|organis|recognis|behaviour|colour|favour|analys|summaris|prioritis|standardis|minimis|initialis|serialis)/i.test(x)).length;
  american += (p.match(/\b\w+(ize|ized|izing|ization|or)\b/gi) ?? []).filter((x) => /(optimiz|organiz|recogniz|behavior|color|favor|summariz|prioritiz|standardiz|minimiz|initializ|serializ)/i.test(x)).length;
  emDash += (p.match(/—/g) ?? []).length;
  oxford += (p.match(/, (and|or) /g) ?? []).length;
}
fences = Math.round(fences / 2);
const per1k = (n: number) => ((n / Math.max(1, totalWords)) * 1000).toFixed(1);
const topLangs = [...langs].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([l, n]) => `\`${l}\` (${n})`).join(", ");
const openings = docs
  .slice(0, 40)
  .map((d) => prose(d.body).split(/\n{2,}/).map((x) => x.trim()).find((x) => x && !/^(#|[-*+] |\d+\. |>|!\[|<|\||:::|import )/.test(x)))
  .filter((x): x is string => Boolean(x) && x!.length > 60)
  .slice(0, 4)
  .map((x) => `> ${x.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ").slice(0, 280)}`);

const spelling = british > american * 1.5 ? "British (-ise, -our)" : american > british * 1.5 ? "American (-ize, -or)" : "mixed; keep each article's existing spelling";
const voice = Number(per1k(firstPersonI)) >= 2 ? "first person singular (\"I\") where the author reports what they built, checked or decided" : Number(per1k(firstPersonWe)) >= 3 ? 'first person plural ("we")' : "impersonal, with second person for instructions";

const text = `# jithendar.com style guide (generated)

Measured from ${docs.length} articles (${docs.filter((d) => d.collection === "blog").length} blog, ${docs.filter((d) => d.collection === "news").length} news; ${totalWords.toLocaleString("en")} words of prose) by \`scripts/seo-style-guide.ts\`. Drafts must read as if the same author wrote them.

## Voice and tone
- Voice: ${voice}. Per 1,000 words: "I/my/me" ${per1k(firstPersonI)}, "we/our" ${per1k(firstPersonWe)}, "you/your" ${per1k(secondPerson)}.
- Direct, technical and specific: name the tool, the version and the command; explain why, then how. No hype, no marketing adjectives, no filler intros ("In today's fast-paced world…").
- Claims are checked: the articles cite sources and state what was verified. Never add a claim, number, version or command that is not in the article or a cited source.
- Spelling: ${spelling} (counted ${british} British vs ${american} American forms). Em dashes appear ${per1k(emDash)} times per 1,000 words; the serial (Oxford) comma is ${oxford > docs.length * 3 ? "common" : "used sparingly"}.

Openings, verbatim, for tone:

${openings.join("\n\n")}

## Structure
- Headings: ${pct(sentenceCase, headings)}% sentence case (capitalise only the first word and proper nouns). ${h2} H2, ${h3} H3, ${h4} H4 across all articles; the title is the only H1 (never add an H1 to the body). Do not skip levels.
- ${pct(questionHeadings, headings)}% of headings are questions; FAQ-style sections use questions as H2/H3 with a short direct answer underneath.
- Paragraphs: median ${median(paraLens)} words; sentences: median ${median(sentenceLens)} words. Keep added paragraphs in that range.
- Lists are common (${(lists / docs.length).toFixed(1)} list items per article) for steps, options and checks; tables (${tables} in total) for comparisons. ${directives ? `Callout directives (\`:::note\` etc.) appear ${directives} times.` : ""}

## Code
- ${fences} fenced blocks; ${pct(fencesWithLang, fences)}% declare a language. Most used: ${topLangs || "n/a"}.${fencesWithTitle ? ` ${fencesWithTitle} use a \`title=\` filename.` : ""}
- Code blocks are copy-paste ready and are never edited by an SEO draft unless the change explicitly targets that block and cites a source.
- Inline code for commands, flags, file names, resource kinds and env vars.

## Titles and descriptions
- Article titles: median ${median(titleLens)} characters. Search titles (seoTitle) should stay ≤ 60 characters, lead with what the reader searches for, and stay accurate; no clickbait, no year unless the article is about that year.
- Descriptions: median ${median(descLens)} characters; meta descriptions ≤ 155 characters, one or two plain sentences that say what the reader gets.

## Links
- Internal links use natural phrases already in the sentence (2–6 words), never "click here"; at most one link per target per article.
`;

fs.mkdirSync("docs/seo", { recursive: true });
fs.writeFileSync("docs/seo/STYLE_GUIDE.md", text);
fs.writeFileSync(
  "src/lib/seo-intel/style-guide.ts",
  `// GENERATED by scripts/seo-style-guide.ts from the site's articles. Do not edit by hand; re-run the script.\n// Fed to Claude as a cached system block so drafts sound like the site (docs/seo/STYLE_GUIDE.md).\nexport const STYLE_GUIDE = ${JSON.stringify(text)};\n`,
);
console.log(`Style guide written from ${docs.length} articles.`);
