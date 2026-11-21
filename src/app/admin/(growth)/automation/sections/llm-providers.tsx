import { LlmProvidersCard } from "@/components/seo/LlmProvidersCard";
import { loadLlmProviders } from "@/lib/llm-providers-view";

/** AI & SEO settings → LLM providers & models: the seo-agent's providers, sealed keys and models with prices. */
export default async function LlmProvidersSection() {
  return <LlmProvidersCard load={await loadLlmProviders()} />;
}
