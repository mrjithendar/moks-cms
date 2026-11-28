import { AI_SEO_RENDERS, type SectionRender } from "@/app/admin/(growth)/automation/sections";
import { ContentFetchingSection, CrewaiRepositorySection } from "./agent-extras";
import BackupsSection from "./backups";
import { EmailProviderSection, EmailTestSection } from "./email";
import GeminiSection from "./gemini";
import { AppearanceSection, SiteSection } from "./general";
import IndexNowSection from "./indexnow";
import LiteLlmSection from "./litellm";
import InvoicesSection from "./invoices";
import PracticeSection from "./practice";
import PromotionSection from "./promotion";
import RagSection from "./rag";
import { CalcomSection, CloudflareSection, RazorpaySection, runtimeSection } from "./runtime";
import SeoAgentSection from "./seo-agent";
import SocialSection from "./social";
import { MediaStorageSection, moveMediaAvailable, MoveMediaSection } from "./storage";
import { SeoIntegrations } from "@/components/seo/merged/SeoIntegrations";

export type { SectionRender };

/**
 * What each section of the Settings area draws (lib/settings-areas.ts lists them, their names and categories). Called
 * by app/admin/settings/[category]/page.tsx with the address's query, so a render may be async; only the open section
 * is rendered. `available`: listed only while it has something to do.
 */
export type SectionImpl = { render: SectionRender; available?: () => Promise<boolean> };

export const SECTION_RENDERS: Record<string, SectionImpl> = {
  site: { render: SiteSection },
  appearance: { render: AppearanceSection },

  social: { render: SocialSection },
  turnstile: { render: runtimeSection("turnstile") },
  members: { render: runtimeSection("members") },
  avatars: { render: runtimeSection("avatars") },

  promotion: { render: PromotionSection },
  indexnow: { render: IndexNowSection },

  email: { render: EmailProviderSection },
  "email-test": { render: EmailTestSection },

  "media-storage": { render: MediaStorageSection },
  "video-destinations": { render: runtimeSection("video-destinations") },
  "move-media": { render: MoveMediaSection, available: moveMediaAvailable },

  razorpay: { render: RazorpaySection },
  invoices: { render: InvoicesSection },
  calcom: { render: CalcomSection },

  llm: { render: LiteLlmSection },
  gemini: { render: GeminiSection },
  "image-limits": { render: runtimeSection("image-limits") },
  "video-generation": { render: runtimeSection("video-generation") },

  "seo-agent": { render: SeoAgentSection },
  "content-fetching": { render: ContentFetchingSection },
  "crewai-repository": { render: CrewaiRepositorySection },

  verification: { render: runtimeSection("verification") },
  "search-console": { render: () => SeoIntegrations() },

  analytics: { render: runtimeSection("analytics") },
  rag: { render: RagSection },

  practice: { render: PracticeSection },

  backups: { render: BackupsSection },
  cloudflare: { render: CloudflareSection },

  // The SEO agent's own sections (AI & SEO → Settings until 2026-11-26).
  ...Object.fromEntries(Object.entries(AI_SEO_RENDERS).map(([id, render]) => [id, { render }])),
};
