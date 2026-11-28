# LiteLLM as the LLM gateway

With LiteLLM as the gateway (D-109, since 2026-11-28), every text model call of the site goes to one LiteLLM proxy
instead of to each provider. LiteLLM decides which provider and model answer, and it enforces the budgets. moks-cms only
names an alias and a key. Without the gateway settings, nothing changes: the site calls Anthropic (and the providers
set in its admin) directly, under its own budget.

## What goes through it

| Caller | Key | Alias (default) |
|---|---|---|
| SEO agent: every flow, crew, content flow, report (`seo-agent/app/llm_gateway.py`) | `LITELLM_API_KEY` in Secret `seo-agent-env` | Claude Sonnet/Opus ids → `moks-cms-default`, Haiku ids → `moks-cms-fast` |
| Ask the Blog (readers can start it, so it has its own budget) | `LITELLM_ASK_API_KEY` in `seo-agent-env` (the agent's key when unset) | `moks-cms-fast` |
| Web app: drafts, keyword intents (`src/lib/seo-intel/claude.ts`), SEO enrichment (`src/lib/seo-intel/llm.ts`) | `LITELLM_API_KEY` in Secret `jithendar-com-env` | by tier, as for the agent; enrichment `moks-cms-fast` |
| Python practice tutor (`src/lib/practice/ai/tutor.ts`) | `LITELLM_PRACTICE_API_KEY` in `jithendar-com-env` (the web key when unset) | `LITELLM_MODEL_PRACTICE`, else `moks-cms-fast` |

Not through it:

- **AI visibility.** It measures each assistant, so it asks each one itself.
- **Image and video generation** (Gemini, OpenAI images, Veo).
- **Embeddings.** bge-m3 and the ONNX models are not chat models.
- **The weekly Message Batches** of the legacy drafting path. With the gateway they are skipped; the agent's
  `weekly_recommendations_flow` drafts instead.

## Models: aliases

LiteLLM serves two aliases: `moks-cms-default` (drafting, crews) and `moks-cms-fast` (classifying, Ask the Blog,
enrichment, the tutor). moks-rag's Job `litellm-seed-models` creates both, once, pointing at Claude Sonnet and Haiku.

The site's own model settings keep working:

- A Claude Haiku id is asked as the fast alias.
- Any other Claude id is asked as the default alias.
- Any other name (another alias, a model the key may use) is passed as it is, so a crew can be given its own alias.

To change provider or model, edit the alias in LiteLLM (https://jithendar.com/llm/ui → Models + Endpoints → the model →
Edit Settings). It takes effect at once, with no deploy. `LITELLM_MODEL_DEFAULT` and `LITELLM_MODEL_FAST` rename the
aliases the site asks for.

Not available through the gateway:

- the `effort` setting;
- Anthropic's server-side refusal fallback. LiteLLM's own fallbacks, set in LiteLLM, take its place.

Prompt caching still works: the stable system text is sent with `cache_control`.

## Budgets: LiteLLM's

- **Team** `jithendar.com`: one budget for every key together, for example per 30 days.
- **Each key**: its own budget and reset (for example Ask the Blog per day), and rate limits (RPM/TPM) if wanted.

Set both in LiteLLM (Teams, Virtual Keys). Nothing is preset (D3): an empty budget is no limit.

**When a budget is used up**, LiteLLM refuses the call with HTTP 422 `budget_exceeded`:

- a flow run pauses (`paused_budget`), as it did on the site's own budget;
- Ask the Blog answers that it is unavailable;
- the tutor says it reached its budget;
- a draft is marked as stopped by the budget.

**What is not used while the gateway is on:**

- the site's own daily and monthly LLM budget, and Ask the Blog's own daily cap;
- the tutor's daily USD budget.

**What still applies:**

- the tutor's per-person daily request quota;
- the enrichment's daily request limit;
- the content flows' image budgets.

**The site's budget for calls outside LiteLLM.** The budget in Settings → AI & models → LLM providers & budget then
covers only calls that cannot go through LiteLLM: AI visibility. Those calls are checked against the spend not booked
through LiteLLM.

**Spend records.** Every call still writes a `seo_llm_usage` row (provider `litellm`) at the cost LiteLLM charged: its
`x-litellm-response-cost`, or LiteLLM's own per-token prices from `/model/info` for a stream. The breakdowns by purpose,
flow and model therefore agree with LiteLLM's budgets.

**The admin view.** Settings → AI & models → LLM providers & budget shows a LiteLLM card, read only:

- the team's and each key's spend, budget and reset (read with the keys themselves);
- what each alias points at and its price.

LiteLLM writes spend to its database in batches, so a total can trail the last calls by up to a minute.

## Turning it on (jithendar.com)

1. **In moks-rag:** `scripts/issue-litellm-keys.sh` creates the team and the four keys (with no budget) and writes the
   keys into the Secrets `jithendar-com-env` and `seo-agent-env`. It never prints them. The aliases come from the seed Job.
2. **In jithendar.com:** the manifests set `LITELLM_BASE_URL=http://litellm.rag.svc.cluster.local:4000/v1` and
   `LITELLM_UI_URL` on both containers, and the NetworkPolicy lets the site pods reach `rag/litellm:4000`. moks-rag's
   AuthorizationPolicy already admits namespace `jithendar`.
3. **Restart** `deploy/jithendar-com`. The agent logs `llm gateway: litellm`, and the admin card appears.
4. **Set the budgets** in LiteLLM: the team, and Ask the Blog's key at least.

To turn it off, remove `LITELLM_API_KEY` from both Secrets and restart. The site is then back on Anthropic directly and
its own budget. `ANTHROPIC_API_KEY` is kept for AI visibility's Claude engine either way.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Flow runs `paused_budget` "LiteLLM refused the call: the budget of … is used up" | A key's or the team's budget in LiteLLM: raise it or wait for its reset. |
| `LiteLLM: The requested model '…' is not available for this API key (HTTP 403 key_model_access_denied)` | The key may not use that alias: add it to the key's models in LiteLLM, or fix a crew's model override. |
| `LiteLLM could not be reached` | The NetworkPolicy (jithendar → rag/litellm:4000), LiteLLM's pods, or `LITELLM_BASE_URL`. |
| The admin card says LiteLLM did not describe a key | The key was deleted or blocked in LiteLLM, or the Secret holds an old one. |
| The card says the SEO agent does not use LiteLLM | `LITELLM_*` is in `jithendar-com-env` but not in `seo-agent-env` (or the reverse). |
