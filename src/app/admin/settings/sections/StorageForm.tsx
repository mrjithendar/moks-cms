"use client";

import { useState } from "react";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Button, Field, Input } from "@/components/ui/form";

export type StorageFormValues = { provider: "r2" | "s3"; region: string; accountId: string; bucket: string; accessKeyId: string; publicBaseUrl: string; endpoint: string; saved: boolean };

/**
 * Media storage settings: Cloudflare R2 or Amazon S3. Only the chosen provider's own field (R2: account ID; S3:
 * region) is shown and sent; the rest is the same S3 API for both.
 */
export function StorageForm({ action, initial }: { action: (form: FormData) => Promise<void>; initial: StorageFormValues }) {
  const [provider, setProvider] = useState(initial.provider);
  const r2 = provider === "r2";
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <fieldset className="sm:col-span-2">
        <legend className="mb-2 text-sm font-medium text-fg">Storage provider</legend>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["r2", "Cloudflare R2", "No egress fees; a custom domain can serve files."],
              ["s3", "Amazon S3", "Any AWS region; CloudFront or a bucket website can serve files."],
            ] as const
          ).map(([v, label, hint]) => (
            <label key={v} className={`flex min-w-56 flex-1 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${provider === v ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong"}`}>
              <input type="radio" name="provider" value={v} checked={provider === v} onChange={() => setProvider(v)} className="mt-0.5" />
              <span>
                <span className="block font-semibold text-fg">{label}</span>
                <span className="text-fg-muted">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {r2 ? (
        <Field label="Account ID" htmlFor="accountId" hint="Cloudflare dashboard → R2 → Account details (32 characters).">
          <Input id="accountId" name="accountId" defaultValue={initial.accountId} required autoComplete="off" />
        </Field>
      ) : (
        <Field label="Region" htmlFor="region" hint="The bucket's AWS region, e.g. us-east-1 or ap-south-1.">
          <Input id="region" name="region" defaultValue={initial.region === "auto" ? "" : initial.region} required placeholder="ap-south-1" autoComplete="off" spellCheck={false} />
        </Field>
      )}
      <Field label="Bucket" htmlFor="bucket">
        <Input id="bucket" name="bucket" defaultValue={initial.bucket} required spellCheck={false} />
      </Field>
      <Field label="Access key ID" htmlFor="accessKeyId" hint={r2 ? "An R2 API token scoped to this bucket (Object Read & Write)." : "An IAM user's access key limited to this bucket (s3:GetObject, PutObject, DeleteObject, ListBucket)."}>
        <Input id="accessKeyId" name="accessKeyId" defaultValue={initial.accessKeyId} required autoComplete="off" />
      </Field>
      <Field label="Secret access key" htmlFor="secretAccessKey" hint={initial.saved ? "Leave empty to keep the stored key." : undefined}>
        <PasswordInput id="secretAccessKey" name="secretAccessKey" autoComplete="off" required={!initial.saved} />
      </Field>
      <Field label="Public media URL (optional)" htmlFor="publicBaseUrl" hint={r2 ? "A custom domain connected to the bucket, e.g. https://media.jithendar.com. Leave empty to serve everything through the site." : "A CloudFront distribution or domain in front of the bucket. Leave empty to serve everything through the site."}>
        <Input id="publicBaseUrl" name="publicBaseUrl" type="url" defaultValue={initial.publicBaseUrl} placeholder="https://media.example.com" />
      </Field>
      <Field label="API endpoint override (optional)" htmlFor="endpoint" hint={r2 ? "Only for an EU/FedRAMP jurisdiction bucket. Default: https://<account>.r2.cloudflarestorage.com" : "Only for an S3-compatible service (MinIO, Wasabi…). Default: https://s3.<region>.amazonaws.com"}>
        <Input id="endpoint" name="endpoint" type="url" defaultValue={initial.endpoint} />
      </Field>
      {!r2 && (
        <p className="text-sm text-fg-muted sm:col-span-2">
          Large uploads go from the browser straight to the bucket, so its CORS configuration must allow <code className="text-xs">PUT</code> from this site with the{" "}
          <code className="text-xs">Content-Type</code> and <code className="text-xs">Cache-Control</code> headers.
        </p>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" className="w-full sm:w-auto">Save and test connection</Button>
      </div>
    </form>
  );
}
