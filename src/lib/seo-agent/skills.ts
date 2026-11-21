import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { audit } from "../audit";
import type { Actor } from "../posts";

/**
 * Agent skills (D-96, docs/seo/CREWS.md "Skills"): writing and checking guidance the SEO agent's crews put into an
 * agent's system prompt as CrewAI Agent Skills.
 *
 * - The default skills below ship with the site (`builtin`); ensureDefaultSkills() inserts any that are missing, so a
 *   new default appears after a deploy without a migration. Admins can edit, disable and reset a default, but not
 *   delete it (it would come back on the next deploy).
 * - Admins add their own on Automation & AI → Skills (`builtin = false`); those can be deleted.
 * - Each skill names the crew agents it is for (`agents`) and, optionally, when it applies (`tags`). A run's tags come
 *   from the ML and Search Console signals it already carries (the brief's intent and source, the recommendation
 *   categories, the news classifier's topics…); a skill with no tags applies to every run of its agents, one with tags
 *   when the run has any one of them. The seo-agent does the matching (app/crews/skills.py); this file serves the
 *   enabled skills on the callback API (GET /internal/seo-agent/skills).
 *
 * Skills are instructions, not data: only admins can write them, and the agent places them in the system prompt.
 */

export const CREWS = {
  editorial: "Editorial crew (new articles and Improve)",
  optimization: "Optimization crew (existing articles)",
  promotion: "Promotion crew (posts and article ideas)",
  report: "Report crew (weekly and monthly briefing)",
  news: "News desk crew",
} as const;
export type CrewId = keyof typeof CREWS;

/** Every crew agent a skill can be given to. Pinned to the agents in moks-seo-agent/app (tests/test_skills.py). */
export const CREW_AGENTS: { key: string; crew: CrewId; label: string }[] = [
  { key: "editorial.researcher", crew: "editorial", label: "Researcher" },
  { key: "editorial.writer", crew: "editorial", label: "Technical writer" },
  { key: "editorial.reviewer", crew: "editorial", label: "Technical reviewer" },
  { key: "editorial.seo_editor", crew: "editorial", label: "SEO editor" },
  { key: "optimization.analyst", crew: "optimization", label: "SEO analyst" },
  { key: "optimization.editor", crew: "optimization", label: "Editor" },
  { key: "optimization.reviewer", crew: "optimization", label: "Technical reviewer" },
  { key: "promotion.copywriter", crew: "promotion", label: "Promotion copywriter" },
  { key: "promotion.strategist", crew: "promotion", label: "Content strategist" },
  { key: "report.analyst", crew: "report", label: "SEO report writer" },
  { key: "news.researcher", crew: "news", label: "News researcher" },
  { key: "news.analyst", crew: "news", label: "Analyst" },
  { key: "news.writer", crew: "news", label: "News writer" },
  { key: "news.fact_checker", crew: "news", label: "Fact-checker" },
  { key: "news.seo_editor", crew: "news", label: "SEO editor" },
  { key: "news.art_director", crew: "news", label: "Art director" },
];

/** The tags a run can carry, for the Skills page's help and for validation. `<value>` parts are open-ended. */
export const SKILL_TAGS: { tag: string; crew: CrewId; meaning: string }[] = [
  { tag: "intent:<how-to|explainer|comparison|troubleshooting|reference>", crew: "editorial", meaning: "The brief's search intent: from the editorial idea, or from the ML intent model for the item's queries." },
  { tag: "intent:<informational|commercial|navigational>", crew: "editorial", meaning: "Intent labels of the ML intent model, when it set the brief's intent." },
  { tag: "source:<ml|analytics|ask|promotion|manual>", crew: "editorial", meaning: "Where the calendar idea came from: ML query clusters, Google Analytics, Ask the Blog, the Promotion crew, or added by hand." },
  { tag: "queries:many", crew: "editorial", meaning: "The brief has three or more supporting Search Console queries." },
  { tag: "revise", crew: "editorial", meaning: "Improve: the crew revises the item's current draft." },
  { tag: "category:<low_ctr|striking_distance|content_decay|content_gap|internal_links|outdated_tech|quality>", crew: "optimization", meaning: "The categories of the recommendations being implemented." },
  { tag: "topic:<slug>", crew: "news", meaning: "A news topic the classifier gave the story's cluster (the topics are your categories)." },
  { tag: "mode:<single|digest>", crew: "news", meaning: "One story, or a digest of several." },
  { tag: "cve", crew: "news", meaning: "The story names a CVE id." },
  { tag: "release", crew: "news", meaning: "The story is about a software release (a version number or a release word in its title)." },
  { tag: "report:<weekly|monthly>", crew: "report", meaning: "The report's period." },
];
const TAG_RE = /^(?:(?:intent|source|queries|category|topic|mode|report):[a-z0-9][a-z0-9_.-]{0,60}|cve|release|revise)$/;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AGENT_KEYS = new Set(CREW_AGENTS.map((a) => a.key));
const isAgentRef = (a: string) => AGENT_KEYS.has(a) || (a.endsWith(".*") && a.slice(0, -2) in CREWS);

export const LIMITS = { name: 64, description: 1024, instructions: 8000, agents: 20, tags: 20 } as const;

export type DefaultSkill = { name: string; description: string; agents: string[]; tags: string[]; instructions: string };

const lines = (...l: string[]) => l.join("\n");

/** The skills every site starts with. Changing one here changes it everywhere it was not edited (Reset brings it back). */
export const DEFAULT_SKILLS: DefaultSkill[] = [
  {
    name: "technical-research",
    description: "How to research a technical article: which sources to trust, what to record, and how to report gaps.",
    agents: ["editorial.researcher"],
    tags: [],
    instructions: lines(
      "Trust sources in this order: the project's official documentation for the current stable version, then its release notes and changelog, then its source repository (README, docs folder, maintainers' answers in issues). Blog posts and Q&A answers are leads to check, never the source.",
      "- Record the version each page documents. Where the docs have a version selector, use the current stable version and say which one.",
      "- Copy commands, flags, defaults, API versions and file paths exactly, each with the URL it came from.",
      "- Look for what changed recently: deprecations, renamed flags, removed APIs, new defaults. Readers get these wrong most often.",
      "- When two sources disagree, report both with their URLs and say which is newer.",
      "- For each outline section, note the failure an engineer is most likely to hit and what the docs say about it.",
      "- Say plainly when a section has no source. A reported gap is better than a guess.",
    ),
  },
  {
    name: "how-to-article",
    description: "Structure for step-by-step guides: prerequisites, one action per step with the expected output, verification and clean-up.",
    agents: ["editorial.writer"],
    tags: ["intent:how-to"],
    instructions: lines(
      "The reader wants to finish a task. Get them there with the fewest surprises.",
      "- Open with what they will have at the end and roughly how long it takes.",
      "- Prerequisites: the tools and the versions the steps were checked against, the access needed, and anything that costs money.",
      "- Steps: one action per step. Each gives the command or configuration, then the output or state to expect, so the reader knows it worked before moving on.",
      "- Name the values the reader must change (namespace, domain, region) the first time they appear, and keep the same example values throughout.",
      "- After the steps, a verification section that proves the whole setup works end to end.",
      "- Close with the most common failure for this setup and its fix, then how to undo or clean up.",
    ),
  },
  {
    name: "explainer-article",
    description: "Structure for concept explainers and reference pages: the problem first, the mechanism, one worked example, and the limits.",
    agents: ["editorial.writer"],
    tags: ["intent:explainer", "intent:reference"],
    instructions: lines(
      "The reader wants to understand something well enough to make a decision or debug it.",
      "- Start with the problem the concept solves, in one or two sentences, before any definition.",
      "- Explain the mechanism: what happens, in order, between the parts involved. A mermaid diagram helps when three or more parts interact.",
      "- Carry one concrete example (a real resource, request or configuration) through the whole article instead of switching examples per section.",
      "- Include the limits: the trade-offs, and the cases where a simpler option is better.",
      "- If there is a common misconception about the topic, correct it and say where it comes from.",
      "- Reference pages: tables for options, defaults and versions, every row from a source.",
    ),
  },
  {
    name: "troubleshooting-article",
    description: "Structure for error-and-fix articles: the exact symptom, how to diagnose, causes ranked by likelihood, fix and verify.",
    agents: ["editorial.writer"],
    tags: ["intent:troubleshooting"],
    instructions: lines(
      "The reader has a broken system and an error message, and skims for their exact symptom.",
      "- Put the exact error message or symptom in the opening and, where it fits, in a heading, as the reader would paste it into a search engine.",
      "- Diagnose first: the commands that show which cause applies, and what each output means.",
      "- List causes from most to least likely. For each: how to confirm it, the fix, and how to verify the fix worked.",
      "- Keep each fix self-contained, so a reader who jumps straight to it does not need the previous section.",
      "- Say which fixes are safe in production and which restart, delete or reset something.",
      "- End with prevention: the setting, check or alert that would have caught it.",
    ),
  },
  {
    name: "comparison-article",
    description: "Structure for X-versus-Y articles: fair criteria, an early comparison table, and when to choose each option.",
    agents: ["editorial.writer"],
    tags: ["intent:comparison", "intent:commercial"],
    instructions: lines(
      "The reader is choosing between options and wants a fair, specific answer.",
      "- Say in the opening which options and versions are compared, and for what kind of team or workload.",
      "- Use the criteria that decide the choice in practice (operational effort, cost model, ecosystem, limits, migration path), the same criteria for every option.",
      "- Put a comparison table early; explain after it the rows that need nuance.",
      "- Every claim about a product's capability or limit needs a source from the research. Leave out marketing claims nobody can verify.",
      "- End with when to choose each option. Do not name a single winner without saying for whom.",
      "- If the author used one of the options, say so and what they saw: that first-hand detail is the article's value.",
    ),
  },
  {
    name: "search-cluster-coverage",
    description: "When the brief comes from an ML query cluster: answer each question the searches show, in the readers' own words.",
    agents: ["editorial.writer", "editorial.seo_editor"],
    tags: ["source:ml", "queries:many"],
    instructions: lines(
      "The brief's supportingQueries are real Search Console searches that the query-clustering model grouped as one topic. They show what readers want to know.",
      "- Answer the first (most common) query in the opening two or three sentences.",
      "- Group the other queries by the question behind them. Each distinct question gets a section, or a clearly marked answer inside one.",
      "- Use the readers' wording in headings where it reads naturally; never repeat a query word for word just to include it.",
      "- A query that needs a different article (another intent or another product) is out of scope: leave it out rather than bolting on a section.",
      "- SEO editor: the title targets the cluster's main query, and the meta description promises only answers the article gives.",
    ),
  },
  {
    name: "reader-question-answer",
    description: "When readers asked the question on Ask the Blog: answer it directly first, then go deep.",
    agents: ["editorial.writer"],
    tags: ["source:ask"],
    instructions: lines(
      "This topic comes from questions readers asked the site's Ask the Blog assistant that no article answered.",
      "- Answer the question directly in the first paragraph, in plain words, before any background.",
      "- Then give the depth: the why, the steps or the trade-offs, with examples.",
      "- Cover the follow-up questions a reader would ask next; the brief's notes may list related questions.",
      "- Use the question's wording in the title or the first heading where it reads naturally.",
    ),
  },
  {
    name: "engagement-follow-up",
    description: "When the topic follows up an article readers engage with: build on it without repeating it.",
    agents: ["editorial.writer"],
    tags: ["source:analytics"],
    instructions: lines(
      "This topic was chosen because readers engage strongly with a related article on this site (Google Analytics).",
      "- Assume many readers arrive from that article: link to it once, early, for the background, and do not repeat its content.",
      "- Go one step further: the next task, the production version, or the scaling or failure case the first article left out.",
      "- Keep the same example setup and names where it makes sense, so the two articles read as a series.",
    ),
  },
  {
    name: "technical-fact-check",
    description: "Checklist for reviewing commands, versions, config and code in technical writing against the sources.",
    agents: ["editorial.reviewer", "optimization.reviewer"],
    tags: [],
    instructions: lines(
      "Check every item, not only the ones that look wrong.",
      "- Commands: the subcommand and every flag exist in the version the article targets; spelling and short or long forms match the docs.",
      "- Defaults and limits: ports, timeouts, sizes and quotas match the source for that version.",
      "- APIs and config: apiVersion, kind and field names are current and not deprecated; YAML nesting is valid; required fields are present.",
      "- Consistency: names, namespaces, file paths and versions are the same in every code block and in the prose.",
      "- Time-sensitive words (latest, new, recently, now supports) need a version or a date from a source, or they go.",
      "- Output shown as expected must be plausible for the command shown.",
      "- Anything you cannot verify is flagged with what is missing, never rewritten from memory.",
    ),
  },
  {
    name: "search-metadata",
    description: "Titles, meta descriptions, slugs and headings that match search intent without clickbait.",
    agents: ["editorial.seo_editor", "news.seo_editor"],
    tags: [],
    instructions: lines(
      "- Title: the main query, or its closest natural phrasing, near the start, plus the specific outcome or angle. No teasers, no capitals for emphasis, no year unless the content is tied to a version or a year.",
      "- Meta description: what the reader gets and one concrete detail from the article (a version, a command, a number). It must not promise anything the body does not deliver.",
      "- Slug: short, lowercase, the topic's key words only; no dates and no stop words.",
      "- Headings: descriptive, so the outline alone tells a reader what each section answers; questions where readers search in questions.",
      "- Internal links: only where the linked article is the natural next read, with an anchor that names what the reader will find there.",
    ),
  },
  {
    name: "search-diagnosis",
    description: "Reading Search Console evidence: which numbers point to which problem, and when not to conclude anything.",
    agents: ["optimization.analyst"],
    tags: [],
    instructions: lines(
      "- Low CTR at a good position (top 5) points at the title and meta description: they do not match the query, or richer results win the click.",
      "- Positions of about 8 to 20 with many impressions are striking distance: the page is relevant but thin or off-target for those queries.",
      "- Falling clicks with steady impressions: a CTR problem or a change in the results page. Falling impressions: lost rankings or lost demand; check the trend input before blaming the article.",
      "- Queries the page gets impressions for but never addresses are a content gap inside the article.",
      "- Draw no conclusion from fewer than about 100 impressions, or from one week against seasonal traffic.",
      "- Name the specific queries, positions and part of the article involved: the editor works from your statement.",
    ),
  },
  {
    name: "ctr-improvement",
    description: "Edits that raise click-through and close striking-distance gaps: title, meta description, opening and focused additions.",
    agents: ["optimization.editor"],
    tags: ["category:low_ctr", "category:striking_distance"],
    instructions: lines(
      "- Start with the title and meta description: match the wording of the queries with the most impressions, and state the concrete outcome.",
      "- Make sure the first paragraph answers the main query directly; it is the text search engines quote.",
      "- For question queries the article never answers, add a short, direct answer paragraph in the section where it belongs.",
      "- Rename a heading only when it hides what the section answers.",
      "- Never change the slug or URL, and leave sections that already perform well alone.",
    ),
  },
  {
    name: "content-refresh",
    description: "Refreshing a decaying, outdated or thin article: update versions and commands, fill gaps, keep what still works.",
    agents: ["optimization.editor"],
    tags: ["category:content_decay", "category:outdated_tech", "category:quality", "category:content_gap"],
    instructions: lines(
      "- Update what aged: versions, deprecated commands and flags, renamed APIs, changed defaults. Each update needs a source the reviewer can check.",
      "- Fill the gaps the evidence names: a missing answer or section for queries the page gets impressions for.",
      "- Keep the structure, the URL and every passage that is still correct; a refresh is not a rewrite.",
      "- Where behaviour differs between versions, say which version each instruction applies to.",
      "- Correct or remove claims that are no longer true instead of adding a note beside them.",
    ),
  },
  {
    name: "promotion-copy",
    description: "Channel norms for promotion posts: LinkedIn, Reddit, Hacker News, X, dev.to, Hashnode, Facebook and newsletters.",
    agents: ["promotion.copywriter"],
    tags: [],
    instructions: lines(
      "- LinkedIn: the concrete problem or result in the first line (all that shows before \"see more\"), short paragraphs, at most three relevant hashtags at the end.",
      "- Reddit: put the useful part in the post itself, written for that subreddit's readers; be open that you wrote the article; no marketing tone.",
      "- Hacker News: the article's own title or a plain description of it; no hype, no emoji, no exclamation marks.",
      "- X: one specific finding from the article plus the link.",
      "- dev.to and Hashnode: a short opening paragraph on who the article is for and what they will be able to do.",
      "- Facebook: conversational, one or two short paragraphs.",
      "- Newsletter: one paragraph on why this is worth the reader's time this week.",
      "- Everywhere: one idea per post, the author's own voice, and nothing the article does not say.",
    ),
  },
  {
    name: "topic-selection",
    description: "Choosing article topics from demand signals: search demand, active discussion, coverage gaps and first-hand fit.",
    agents: ["promotion.strategist"],
    tags: [],
    instructions: lines(
      "Rank candidate topics on four things, in this order:",
      "1. Demand: Search Console queries with impressions (several related queries beat one), or discussions with real replies.",
      "2. Gap: nothing published or planned covers it, or the existing article ranks beyond position 10 for it.",
      "3. Fit: it belongs to the site's subjects and audience, and the author can write it from first-hand work.",
      "4. Lasting value: a topic that stays true for a year beats news that fades in a week.",
      "- One idea per search intent: two ideas answering the same question are one idea.",
      "- Prefer a specific angle (rotating cert-manager certificates without downtime) to a broad subject (cert-manager).",
      "- Drop an idea that only one weak signal supports.",
    ),
  },
  {
    name: "seo-briefing",
    description: "Writing the weekly or monthly SEO briefing: the change that matters, its likely reason, and the next actions.",
    agents: ["report.analyst"],
    tags: [],
    instructions: lines(
      "- Lead with the most important change of the period, then the others in order of impact.",
      "- Separate signal from noise: a change on a small base, or within normal week-to-week variation, is described as such or left out.",
      "- Give a reason only when the facts support it (an article published, a recommendation implemented, a ranking change for a named query); otherwise say the cause is not clear from the data.",
      "- Next actions are concrete: which article, which change, and why now.",
      "- Plain words for a busy owner; explain any jargon in a few words.",
    ),
  },
  {
    name: "news-sourcing",
    description: "Sourcing news: primary sources first, exact versions and dates, supporting snippets, and nothing unconfirmed.",
    agents: ["news.researcher", "news.fact_checker"],
    tags: [],
    instructions: lines(
      "- Primary sources first: the vendor's release notes, security advisory, changelog, official blog or documentation. Press coverage points to the primary source; it does not replace it.",
      "- Dates: tell apart when something was announced, released and takes effect, each with its source.",
      "- Copy versions, CVE ids, product names and numbers exactly as the primary source writes them.",
      "- Every fact-sheet claim carries a short verbatim snippet from a page fetched in this run that supports it.",
      "- Rumours, leaks, roadmap hints and unnamed sources stay out of the fact sheet.",
      "- Fact-checker: a claim whose snippet does not say what the draft says is removed, even when it is probably true.",
    ),
  },
  {
    name: "news-analysis",
    description: "Turning a news story into practical analysis for engineers who run production systems.",
    agents: ["news.analyst", "news.writer"],
    tags: [],
    instructions: lines(
      "- Say what changed in one or two sentences, then spend the article on what it means in practice.",
      "- Who is affected: be specific about versions, platforms, configurations or plans, and say who is not affected.",
      "- What to do: concrete actions with a timeframe (now, at the next upgrade, nothing needed), and how to check whether you are affected.",
      "- Context: how this compares with the previous version or the alternatives, only from sources.",
      "- No speculation about motives, the future or market impact.",
    ),
  },
  {
    name: "security-advisory",
    description: "Covering vulnerabilities: CVE ids, severity, affected and fixed versions, exploitation status and mitigation.",
    agents: ["news.analyst", "news.writer", "news.fact_checker"],
    tags: ["cve", "topic:security"],
    instructions: lines(
      "- Lead with the CVE id(s), the affected product and the fixed version.",
      "- Severity: the CVSS score and who assigned it (NVD or the vendor); when they differ, give both.",
      "- Affected and fixed versions exactly as the advisory lists them; never widen or narrow the range.",
      "- Say exploited in the wild only when CISA KEV or the vendor says so; otherwise say the sources report no exploitation.",
      "- What to do: the upgrade path first, then the vendor's mitigation if patching has to wait, then how to check whether you run an affected version.",
      "- No exploit details or proof-of-concept code.",
    ),
  },
  {
    name: "release-coverage",
    description: "Covering a software release: the changes operators will notice, breaking changes, and the upgrade path.",
    agents: ["news.analyst", "news.writer"],
    tags: ["release"],
    instructions: lines(
      "- Lead with the version and the two or three changes operators will notice.",
      "- Breaking changes, removals and deprecations get their own section, each with what to change before upgrading.",
      "- Keep generally available features apart from beta or alpha ones, as the release notes label them.",
      "- Upgrade notes: supported upgrade paths, required intermediate versions and known issues, from the release notes.",
      "- Skip the long tail of minor fixes unless one closes a well-known problem.",
    ),
  },
  {
    name: "news-digest",
    description: "Writing a news digest: one tight section per story, ordered by impact, under a title that names the theme.",
    agents: ["news.writer", "news.seo_editor"],
    tags: ["mode:digest"],
    instructions: lines(
      "- Order stories by how much they affect the reader's systems, not by time.",
      "- Each story: one or two sentences on what happened, one on why it matters, and its sources. Keep the sections a similar length.",
      "- Open with one sentence tying the stories together if there is a real theme; otherwise just say what the digest covers.",
      "- SEO editor: the title names the period and the most important story or theme, not a generic roundup label.",
    ),
  },
  {
    name: "cover-image-brief",
    description: "Briefing an abstract cover illustration that fits the story and stays safe to publish.",
    agents: ["news.art_director"],
    tags: [],
    instructions: lines(
      "- Choose one visual metaphor for the story's subject (data flowing between nodes, a layered stack, a shield over a cluster, a broken link) and describe it concretely.",
      "- Composition: one clear focal point, wide 16:9 framing, and calm space where a title could sit.",
      "- Colour and mood follow the story: calm for releases, higher contrast for security issues, never alarmist.",
      "- Always avoid people, faces, hands, logos, product marks, readable text, UI screenshots and anything that imitates a real product.",
    ),
  },
];
const DEFAULT_BY_NAME = new Map(DEFAULT_SKILLS.map((s) => [s.name, s]));

// --- validation -------------------------------------------------------------------------------------------------------

const noSkillTags = (s: string) => !/<\/?\s*skill\b/i.test(s);
const fields = {
  description: z.string().trim().min(1).max(LIMITS.description),
  instructions: z.string().trim().min(1).max(LIMITS.instructions).refine(noSkillTags, "Instructions cannot contain <skill> tags."),
  agents: z
    .array(z.string().trim())
    .min(1, "Choose at least one agent.")
    .max(LIMITS.agents)
    .refine((a) => a.every(isAgentRef), "Unknown agent: use the agents listed on the page, or <crew>.* for all of a crew's agents.")
    .transform((a) => [...new Set(a)]),
  tags: z
    .array(z.string().trim().toLowerCase())
    .max(LIMITS.tags)
    .refine((t) => t.every((x) => TAG_RE.test(x)), "Unknown tag: use the tags listed on the page (for example intent:troubleshooting or topic:kubernetes).")
    .transform((t) => [...new Set(t)]),
  enabled: z.boolean(),
};
export const skillCreateSchema = z.object({
  name: z.string().trim().toLowerCase().min(1).max(LIMITS.name).regex(NAME_RE, "Name: lowercase letters, digits and single hyphens (for example kubernetes-upgrades)."),
  ...fields,
  tags: fields.tags.default([]),
  enabled: fields.enabled.default(true),
});
export const skillUpdateSchema = z.object(fields).partial().strict();
export type SkillCreate = z.input<typeof skillCreateSchema>;
export type SkillUpdate = z.input<typeof skillUpdateSchema>;

export class SkillError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new SkillError("Invalid skill.", 400, r.error.issues.map((i) => `${i.path.map(String).join(".") || "skill"}: ${i.message}`).slice(0, 20));
  return r.data;
}

// --- storage ----------------------------------------------------------------------------------------------------------

/** A text[] literal for a parameter (drizzle's sql`` would spread an array into a list of parameters). */
const pgText = (a: string[]) => `{${a.map((x) => `"${x.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.replace(/^\{|\}$/g, "").split(",").filter(Boolean).map((x) => x.replace(/^"|"$/g, "")) : []);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

type Row = { id: string; name: string; description: string; instructions: string; agents: unknown; tags: unknown; enabled: boolean; builtin: boolean; version: number; created_at: unknown; updated_at: unknown; updated_by: string | null };
export type Skill = { id: string; name: string; description: string; instructions: string; agents: string[]; tags: string[]; enabled: boolean; builtin: boolean; version: number; updatedAt: string; updatedBy: string | null; /** A default whose text, agents or tags differ from the shipped default. */ edited: boolean };

function toSkill(r: Row): Skill {
  const agents = arr(r.agents);
  const tags = arr(r.tags);
  const d = r.builtin ? DEFAULT_BY_NAME.get(r.name) : undefined;
  const edited = !!d && (d.description !== r.description || d.instructions !== r.instructions || !sameList(d.agents, agents) || !sameList(d.tags, tags));
  return { id: r.id, name: r.name, description: r.description, instructions: r.instructions, agents, tags, enabled: !!r.enabled, builtin: !!r.builtin, version: Number(r.version), updatedAt: new Date(String(r.updated_at)).toISOString(), updatedBy: r.updated_by, edited };
}

const COLS = sql.raw("id, name, description, instructions, agents, tags, enabled, builtin, version, created_at, updated_at, updated_by");

/** Insert the shipped defaults that are missing. A name an admin's own skill already uses is left to that skill. */
export async function ensureDefaultSkills(db?: Db): Promise<number> {
  const d = db ?? (await getDb());
  const have = new Set(rowsOf<{ name: string }>(await d.execute(sql`select name from seo_agent_skills`)).map((r) => r.name));
  let added = 0;
  for (const s of DEFAULT_SKILLS) {
    if (have.has(s.name)) continue;
    const r = await d.execute(sql`
      insert into seo_agent_skills (name, description, instructions, agents, tags, builtin, updated_by)
      values (${s.name}, ${s.description}, ${s.instructions}, ${pgText(s.agents)}::text[], ${pgText(s.tags)}::text[], true, 'system')
      on conflict (name) do nothing returning id`);
    added += rowsOf(r).length;
  }
  return added;
}

export async function listSkills(db?: Db): Promise<Skill[]> {
  const d = db ?? (await getDb());
  await ensureDefaultSkills(d);
  return rowsOf<Row>(await d.execute(sql`select ${COLS} from seo_agent_skills order by builtin desc, name`)).map(toSkill);
}

async function getSkill(d: Db, id: string): Promise<Skill> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new SkillError("Skill not found.", 404);
  const [r] = rowsOf<Row>(await d.execute(sql`select ${COLS} from seo_agent_skills where id = ${id}`));
  if (!r) throw new SkillError("Skill not found.", 404);
  return toSkill(r);
}

export async function createSkill(actor: Actor, raw: unknown, db?: Db): Promise<Skill> {
  const d = db ?? (await getDb());
  const s = parse(skillCreateSchema, raw);
  await ensureDefaultSkills(d);
  const rows = rowsOf<Row>(
    await d.execute(sql`
      insert into seo_agent_skills (name, description, instructions, agents, tags, enabled, builtin, updated_by)
      values (${s.name}, ${s.description}, ${s.instructions}, ${pgText(s.agents)}::text[], ${pgText(s.tags)}::text[], ${s.enabled}, false, ${actor.label})
      on conflict (name) do nothing returning ${COLS}`),
  );
  if (!rows[0]) throw new SkillError(`A skill named ${s.name} already exists.`, 409);
  await audit(actor, "seo.skill.create", s.name, { agents: s.agents, tags: s.tags, enabled: s.enabled });
  return toSkill(rows[0]);
}

/** Edit any skill (a default too); the name never changes. A change of content bumps the version the agent logs. */
export async function updateSkill(actor: Actor, id: string, raw: unknown, db?: Db): Promise<Skill> {
  const d = db ?? (await getDb());
  const patch = parse(skillUpdateSchema, raw);
  const cur = await getSkill(d, id);
  const next = { description: patch.description ?? cur.description, instructions: patch.instructions ?? cur.instructions, agents: patch.agents ?? cur.agents, tags: patch.tags ?? cur.tags, enabled: patch.enabled ?? cur.enabled };
  const content = next.description !== cur.description || next.instructions !== cur.instructions || !sameList(next.agents, cur.agents) || !sameList(next.tags, cur.tags);
  if (!content && next.enabled === cur.enabled) return cur;
  const [r] = rowsOf<Row>(
    await d.execute(sql`
      update seo_agent_skills set description = ${next.description}, instructions = ${next.instructions}, agents = ${pgText(next.agents)}::text[],
        tags = ${pgText(next.tags)}::text[], enabled = ${next.enabled}, version = version + ${content ? 1 : 0}, updated_at = now(), updated_by = ${actor.label}
      where id = ${id} returning ${COLS}`),
  );
  const changed = [...(content ? ["content"] : []), ...(next.enabled !== cur.enabled ? [next.enabled ? "enabled" : "disabled"] : [])];
  await audit(actor, "seo.skill.update", cur.name, { changed, builtin: cur.builtin });
  return toSkill(r!);
}

/** Only an admin's own skills can be deleted: a default would come back on the next deploy, so it is disabled instead. */
export async function deleteSkill(actor: Actor, id: string, db?: Db): Promise<void> {
  const d = db ?? (await getDb());
  const cur = await getSkill(d, id);
  if (cur.builtin) throw new SkillError("Default skills cannot be deleted. Disable it instead.", 409);
  await d.execute(sql`delete from seo_agent_skills where id = ${id}`);
  await audit(actor, "seo.skill.delete", cur.name, {});
}

/** Put a default back to the shipped text, agents and tags (enabled or not stays as it is). */
export async function resetSkill(actor: Actor, id: string, db?: Db): Promise<Skill> {
  const d = db ?? (await getDb());
  const cur = await getSkill(d, id);
  const def = cur.builtin ? DEFAULT_BY_NAME.get(cur.name) : undefined;
  if (!def) throw new SkillError("Only a default skill can be reset.", 409);
  if (!cur.edited) return cur;
  const [r] = rowsOf<Row>(
    await d.execute(sql`
      update seo_agent_skills set description = ${def.description}, instructions = ${def.instructions}, agents = ${pgText(def.agents)}::text[],
        tags = ${pgText(def.tags)}::text[], version = version + 1, updated_at = now(), updated_by = ${actor.label}
      where id = ${id} returning ${COLS}`),
  );
  await audit(actor, "seo.skill.reset", cur.name, {});
  return toSkill(r!);
}

/** GET /internal/seo-agent/skills: the enabled skills, for the crews to match against each run. */
export async function agentSkills(db?: Db) {
  const d = db ?? (await getDb());
  await ensureDefaultSkills(d);
  const rows = rowsOf<Row>(await d.execute(sql`select ${COLS} from seo_agent_skills where enabled order by builtin desc, name limit 200`)).map(toSkill);
  return { skills: rows.map((s) => ({ name: s.name, description: s.description, instructions: s.instructions, agents: s.agents, tags: s.tags, version: s.version, builtin: s.builtin })) };
}
