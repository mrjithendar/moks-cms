import { AdminHeader } from "@/components/admin/ui";
import { SkillsManager } from "@/components/seo/SkillsManager";
import { CREW_AGENTS, CREWS, LIMITS, listSkills, SKILL_TAGS } from "@/lib/seo-agent/skills";

export const dynamic = "force-dynamic";
export const metadata = { title: "Skills" };

/** AI room → Skills (D-96): the guidance each crew agent gets in its prompt. Defaults ship with the site; admins add more. */
export default async function SkillsPage() {
  const skills = await listSkills();
  return (
    <>
      <AdminHeader
        title="Skills"
        description="Writing and checking guidance the SEO agent's crews load into each agent's instructions. Default skills ship with the site: edit, disable or reset them. Add your own for any agent. Tags choose when a skill applies, from the signals each run already has (the ML intent model and query clusters, Search Console, Google Analytics, the news classifier); a skill without tags applies to every run of its agents. Changes apply from the next run."
      />
      <SkillsManager skills={skills} crews={Object.entries(CREWS).map(([id, label]) => ({ id, label }))} agents={CREW_AGENTS} tags={SKILL_TAGS} limits={LIMITS} />
    </>
  );
}
