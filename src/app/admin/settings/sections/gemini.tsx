import Link from "next/link";
import { LocalTime } from "@/components/LocalTime";
import { SectionHeading } from "@/components/admin/SettingsParts";
import { Card, StatusPill } from "@/components/admin/ui";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Alert, Button, Field, Input, Select } from "@/components/ui/form";
import { adminActor } from "@/lib/admin";
import { flash } from "@/lib/flash";
import { IMAGE_SIZES } from "@/lib/gemini";
import { geminiSummary, removeGeminiKey, saveGemini } from "@/lib/integrations";
import { PostError } from "@/lib/posts";
import { settingsHref } from "@/lib/settings-areas";
import { storageReady } from "@/lib/storage";
import { SOURCE } from "./source";

async function saveImageGeneration(form: FormData) {
  "use server";
  const actor = await adminActor();
  await flash(settingsHref("gemini"), async () => {
    if (form.get("intent") === "reset") {
      await removeGeminiKey(actor);
      return "Gemini settings removed. Environment variables apply again, if set.";
    }
    const r = await saveGemini(actor, {
      enabled: form.has("enabled"),
      apiKey: String(form.get("apiKey") ?? ""),
      model: String(form.get("model") ?? ""),
      proModel: String(form.get("proModel") ?? ""),
      imageSize: String(form.get("imageSize") ?? "1K"),
      maxImageSize: String(form.get("maxImageSize") ?? ""),
    });
    if (r.error) throw new PostError(`Saved, but the key check failed: ${r.error} “Generate image” stays available; requests will fail until this is fixed.`);
    return r.verified ? "Gemini key verified and saved. “Generate image” is available in the editor." : "Image generation is off.";
  });
}

/** Settings → AI & models → Image generation (Settings → Integrations until 2026-11-26). */
export default async function GeminiSection() {
  const [gemini, storage] = await Promise.all([geminiSummary(), storageReady()]);
  return (
    <section aria-labelledby="gemini-title" className="space-y-4">
      <SectionHeading
        id="gemini-title"
        title="Image generation (Gemini)"
        description={
          <>
            Powers “✨ Generate image” for cover images in the post and page editors. Results are saved to the media library only when an author accepts them. Per-author and daily
            limits are under <Link href={settingsHref("image-limits")} className="link">Image limits</Link>; video uses the same key (<Link href={settingsHref("video-generation")} className="link">Video generation</Link>).
          </>
        }
      />
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-fg">Google Gemini API</h3>
          <div className="flex items-center gap-2 text-xs text-fg-subtle">
            {gemini.source !== "none" && SOURCE[gemini.source]}
            <StatusPill status={!gemini.enabled ? (gemini.source === "none" ? "not configured" : "closed") : gemini.lastError ? "test failed" : gemini.verifiedAt ? "tested" : "configured"} />
          </div>
        </div>
        {!storage && (
          <div className="mb-4">
            <Alert tone="info">
              Media storage (Cloudflare R2) must be configured in <Link href={settingsHref("media-storage")} className="link">Settings → Media &amp; storage</Link> before generated images can be saved.
            </Alert>
          </div>
        )}
        {gemini.lastError && (
          <div className="mb-4">
            <Alert>Last key check failed: {gemini.lastError}</Alert>
          </div>
        )}
        <p className="mb-4 text-sm text-fg-muted">
          Create a key in <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="link">Google AI Studio → API keys</a>. Saving checks the key and model
          with a free metadata request; no image is generated. The key is encrypted at rest and never shown again.
          {gemini.verifiedAt && <> Last verified {<LocalTime iso={gemini.verifiedAt} />}.</>}
        </p>
        <form action={saveImageGeneration} className="grid gap-4 sm:grid-cols-2">
          <Field label="API key" htmlFor="g-key" hint={gemini.hasKey ? `Stored (${gemini.keyHint}). Leave empty to keep it.` : "Starts with AIza…"}>
            <PasswordInput id="g-key" name="apiKey" autoComplete="off" />
          </Field>
          <Field label="Image model (Fast)" htmlFor="g-model" hint="Model code from ai.google.dev/gemini-api/docs/models. The default in the editor.">
            <Input id="g-model" name="model" defaultValue={gemini.model || "gemini-3.1-flash-image"} required spellCheck={false} />
          </Field>
          <Field label="Pro model (optional)" htmlFor="g-pro-model" hint="Higher quality, slower and dearer. Leave empty to offer only Fast.">
            <Input id="g-pro-model" name="proModel" defaultValue={gemini.proModel} spellCheck={false} />
          </Field>
          <Field label="Default image size" htmlFor="g-size" hint="Preselected in the editor. Larger sizes cost more and take longer (model-dependent).">
            <Select id="g-size" name="imageSize" defaultValue={gemini.imageSize}>
              {IMAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Largest size authors may pick" htmlFor="g-max-size" hint="Caps cost. Default: the larger of the default size and 2K.">
            <Select id="g-max-size" name="maxImageSize" defaultValue={gemini.maxImageSize}>
              <option value="">Default</option>
              {IMAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <label className="flex items-center gap-2 self-end pb-3 text-sm">
            <input type="checkbox" name="enabled" defaultChecked={gemini.source === "none" ? true : gemini.enabled} /> Enable “Generate image”
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" name="intent" value="save">Save and verify</Button>
            {gemini.source === "admin" && <Button type="submit" name="intent" value="reset" variant="ghost">Remove stored key</Button>}
          </div>
        </form>
      </Card>
    </section>
  );
}
