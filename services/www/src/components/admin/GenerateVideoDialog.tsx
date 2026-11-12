"use client";

import { useEffect, useRef, useState } from "react";
import { acceptGeneratedVideo, discardGeneratedVideo } from "@/app/admin/_actions/shared";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Dialog } from "./Dialog";

export type GenerateVideoOptions = { enabled: boolean; reason?: string; aspectRatios: readonly string[]; model?: string; destinations?: { id: string; label: string }[] };
/** `embed`: `src` is an external player (::embed, playback options already in the address); otherwise a /media/… file (::video). */
export type InsertedVideo = { src: string; ratio: string; caption: string; loop: boolean; embed: boolean; title: string };

type Phase = { name: "compose" } | { name: "generating"; id: string | null } | { name: "preview"; id: string; previewUrl: string; model: string };
type Progress = { status?: "running" | "succeeded" | "failed"; previewUrl?: string; model?: string; error?: string };

const POLL_MS = 8_000;

export function defaultVideoPrompt(title: string, hint: string): string {
  const parts = [
    `A short, looping explanatory animation for a technology article titled "${title.trim() || "Untitled"}".`,
    hint.trim() ? `It illustrates: ${hint.trim()}` : "",
    "Clean, modern motion-graphics style with smooth, simple movement. No text, letters, logos, watermarks or people.",
  ];
  return parts.filter(Boolean).join(" ");
}

/**
 * Generate a short video clip (Veo through the Gemini API), preview it, then Insert / Regenerate / Discard.
 * A clip takes a few minutes: the request returns at once and this dialog polls until it is ready. Nothing is
 * added to the media library or the post until the author inserts it; closing the dialog discards it.
 */
export function GenerateVideoDialog({
  open,
  onClose,
  onInsert,
  title,
  hint,
  context,
  options,
}: {
  open: boolean;
  onClose: () => void;
  onInsert: (video: InsertedVideo) => void;
  title: string;
  /** What the clip should show: the selected text or the section being written. */
  hint: string;
  context: string;
  options: GenerateVideoOptions;
}) {
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState(options.aspectRatios[0] ?? "16:9");
  const [phase, setPhase] = useState<Phase>({ name: "compose" });
  const [description, setDescription] = useState("");
  const [caption, setCaption] = useState("");
  const [loop, setLoop] = useState(true);
  const destinations = options.destinations ?? [];
  const [destination, setDestination] = useState(destinations[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** The generation this dialog is waiting for or previewing; discarded when the dialog closes. */
  const pendingId = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped whenever the current wait is abandoned, so a late poll result is ignored. */
  const run = useRef(0);

  // Each time the dialog opens, start from the article's current title and the text being illustrated.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPrompt(defaultVideoPrompt(title, hint));
      setPhase({ name: "compose" });
      setError(null);
      setDescription("");
      setCaption("");
      setLoop(true);
    }
  }

  function stopWaiting() {
    run.current += 1;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }

  // Leaving the dialog never keeps an unaccepted result or a generation nobody is waiting for.
  useEffect(() => {
    if (open) return;
    run.current += 1;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pendingId.current) void discardGeneratedVideo(pendingId.current);
    pendingId.current = null;
  }, [open]);
  // Unmounted while waiting (the author left the editor): stop polling.
  useEffect(() => {
    const runs = run;
    const timers = timer;
    return () => {
      runs.current += 1;
      if (timers.current) clearTimeout(timers.current);
    };
  }, []);

  function poll(id: string, token: number) {
    timer.current = setTimeout(async () => {
      let body: Progress = {};
      try {
        const res = await fetch(`/api/admin/videos/generations/${id}/status`, { cache: "no-store" });
        body = (await res.json().catch(() => ({}))) as Progress;
        if (!res.ok && !body.error) body = { status: res.status >= 500 ? "running" : "failed", error: "The video could not be checked." };
      } catch {
        body = { status: "running" }; // a dropped connection: keep waiting
      }
      if (token !== run.current) return;
      if (body.status === "succeeded" && body.previewUrl) {
        setPhase({ name: "preview", id, previewUrl: body.previewUrl, model: body.model ?? "" });
      } else if (body.status === "running") {
        poll(id, token);
      } else {
        pendingId.current = null;
        setPhase({ name: "compose" });
        setError(body.error ?? "Video generation failed.");
      }
    }, POLL_MS);
  }

  async function generate() {
    if (phase.name === "generating") return; // already running: no duplicate requests
    stopWaiting();
    if (pendingId.current) {
      void discardGeneratedVideo(pendingId.current);
      pendingId.current = null;
    }
    setError(null);
    setPhase({ name: "generating", id: null });
    const token = run.current;
    try {
      const res = await fetch("/api/admin/videos/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, aspectRatio: ratio }) });
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error ?? "Video generation failed.");
      if (token !== run.current) {
        void discardGeneratedVideo(body.id); // the dialog was closed or cancelled while the request was starting
        return;
      }
      pendingId.current = body.id;
      setPhase({ name: "generating", id: body.id });
      poll(body.id, token);
    } catch (e) {
      if (token !== run.current) return;
      setPhase({ name: "compose" });
      setError((e as Error).message);
    }
  }

  async function cancel() {
    stopWaiting();
    if (pendingId.current) await discardGeneratedVideo(pendingId.current);
    pendingId.current = null;
    setPhase({ name: "compose" });
  }

  async function accept(id: string) {
    setSaving(true);
    setError(null);
    const r = await acceptGeneratedVideo(id, description, context, destination, loop);
    setSaving(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    pendingId.current = null;
    onInsert({ src: r.src, ratio: r.aspectRatio, caption: caption.trim(), loop, embed: r.embed, title: description.trim() });
  }

  const generating = phase.name === "generating";
  const footer =
    phase.name === "preview" ? (
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={cancel} disabled={saving}>
          Discard
        </Button>
        <Button type="button" variant="secondary" onClick={generate} disabled={saving}>
          Regenerate
        </Button>
        <Button type="button" onClick={() => accept(phase.id)} disabled={saving || !description.trim()}>
          {saving ? "Sending…" : "Insert video"}
        </Button>
      </div>
    ) : (
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {generating ? (
          <Button type="button" variant="secondary" onClick={cancel}>
            Cancel
          </Button>
        ) : (
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        )}
        <Button type="button" onClick={generate} disabled={generating || prompt.trim().length < 10}>
          {generating ? "Generating…" : "Generate"}
        </Button>
      </div>
    );

  // Only destinations an admin switched on are listed; with a single one there is nothing to choose.
  const destinationField = destinations.length > 1 && (
    <Field label="Save the video to" htmlFor="gen-video-destination" hint="This site plays the file directly. A streaming service encodes it first, so its player can show “processing” for a minute after you insert it.">
      <Select id="gen-video-destination" value={destination} onChange={(e) => setDestination(e.target.value)} disabled={saving}>
        {destinations.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <Dialog open={open} onClose={onClose} title="Generate a video" size="md" footer={footer}>
      <div className="space-y-5">
        {error && <Alert>{error}</Alert>}
        {phase.name === "preview" ? (
          <>
            <figure className="overflow-hidden rounded-xl border border-line bg-surface-muted">
              <video src={phase.previewUrl} controls muted loop playsInline preload="metadata" className="h-auto max-h-[50dvh] w-full" />
              <figcaption className="px-3 py-2 text-xs text-fg-subtle">{phase.model} · not saved yet</figcaption>
            </figure>
            <Field label="Description" htmlFor="gen-video-description" hint="What the video shows, for the media library and for readers who cannot play it. Required.">
              <Input id="gen-video-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} required data-autofocus />
            </Field>
            <Field label="Caption (optional)" htmlFor="gen-video-caption">
              <Input id="gen-video-caption" value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={300} />
            </Field>
            {destinationField}
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} className="mt-1 h-4 w-4" />
              <span>
                <span className="font-medium">Play as a silent loop (like a GIF)</span>
                <span className="block text-fg-subtle">Starts by itself, muted, and repeats. Untick for a normal player with controls and sound.</span>
              </span>
            </label>
          </>
        ) : (
          <>
            <Field label="Prompt" htmlFor="gen-video-prompt" hint="Prefilled from the title and the text you selected. Describe the subject and the movement; avoid asking for text in the video.">
              <Textarea id="gen-video-prompt" rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={2000} disabled={generating} data-autofocus />
            </Field>
            <Field label="Aspect ratio" htmlFor="gen-video-ratio" hint={options.model}>
              <Select id="gen-video-ratio" value={ratio} onChange={(e) => setRatio(e.target.value)} disabled={generating}>
                {options.aspectRatios.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            {destinationField}
            {generating ? (
              <p role="status" className="flex items-center gap-3 text-sm text-fg-muted">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" aria-hidden="true" />
                Generating… a video usually takes a few minutes. Keep this dialog open.
              </p>
            ) : (
              <p className="text-xs text-fg-subtle">A video costs much more than an image and counts against the site&apos;s video limits.</p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
