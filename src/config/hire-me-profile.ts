/**
 * The facts on /hire-me that come from the owner's résumé: the site's config/hire-me-profile.json, read at server
 * start (config/site-files.ts). Prices, booking links, availability and the offers' wording are NOT here: they are
 * edited in Admin → Appearance → Hire me. Keep phone numbers and personal email out of it: the page is public.
 */
import { readSiteJson } from "./site-files";

type HireMeProfile = {
  profile: { name: string; role: string; location: string; yearsExperience: string; linkedin: string; github: string };
  certifications: { name: string; detail: string }[];
  highlights: string[];
  skills: { group: string; items: string[] }[];
  experience: { role: string; org: string; place: string; from: string; to: string }[];
  selectedWork: { title: string; href: string; what: string }[];
  process: { step: string; text: string }[];
};

const EMPTY: HireMeProfile = {
  profile: { name: "", role: "", location: "", yearsExperience: "", linkedin: "", github: "" },
  certifications: [],
  highlights: [],
  skills: [],
  experience: [],
  selectedWork: [],
  process: [],
};

const data: HireMeProfile = { ...EMPTY, ...readSiteJson<Partial<HireMeProfile>>("config/hire-me-profile.json", EMPTY) };

export const PROFILE = data.profile;
export const CERTIFICATIONS = data.certifications;
export const HIGHLIGHTS = data.highlights;
export const SKILLS = data.skills;
export const EXPERIENCE = data.experience;
export const SELECTED_WORK = data.selectedWork;
export const PROCESS = data.process;
