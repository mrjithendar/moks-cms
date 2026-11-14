/**
 * The facts on /hire-me (name, role, experience, skills). Prices, booking links, availability and the offers' wording
 * are not here: they are edited in Admin → Appearance → Hire me. Leave the lists empty if the site has no /hire-me page.
 */

export const PROFILE = {
  name: "Your Name",
  role: "Your role",
  location: "",
  yearsExperience: "",
  linkedin: "",
  github: "",
};

export const CERTIFICATIONS: { name: string; detail: string }[] = [];

/** Things built in production. */
export const HIGHLIGHTS: string[] = [];

export const SKILLS: { group: string; items: string[] }[] = [];

export const EXPERIENCE: { role: string; org: string; place: string; from: string; to: string }[] = [];

/** Public work on this site that shows the kind of thing a client gets. */
export const SELECTED_WORK: { title: string; href: string; what: string }[] = [];

export const PROCESS: { step: string; text: string }[] = [];
