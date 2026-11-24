import "server-only";
import type { Db } from "@/db";
import type { Actor } from "@/lib/posts";
import type { AgentDeps } from "@/lib/seo-agent/client";
import { SeoApiError } from "@/lib/seo-intel/http";
import { allItems, CatalogError, createItem, deleteItem, getItem, servedSpecs, setEnabled, updateItem, type CatalogItem } from "./catalog";

/**
 * The custom crews and flows API of crew-jobs plan PR 6 (/api/admin/crewai/custom/{crews|flows}), kept for scripts and
 * bookmarks. Since migration 0041 there are no custom crews or flows, only crews and flows (lib/crewai/catalog.ts): this
 * file reads and writes the catalogue's rows that are defined by a spec, with the behaviour the old API had.
 */
export type CustomKind = "crew" | "flow";
export type CustomRow = { key: string; label: string; spec: Record<string, unknown>; version: number; enabled: boolean; updated_at: string; updated_by: string | null };
export const CustomError = CatalogError;

const row = (i: CatalogItem): CustomRow => ({ key: i.key, label: i.label, spec: i.spec ?? {}, version: i.version, enabled: i.enabled, updated_at: i.updatedAt, updated_by: i.updatedBy });

/** Every saved spec crew or flow (not deleted), enabled or not. */
export async function listCustom(kind: CustomKind, db?: Db): Promise<CustomRow[]> {
  return (await allItems(kind, db)).filter((i) => i.definition === "spec").map(row);
}

export async function getCustom(kind: CustomKind, key: string, db?: Db): Promise<CustomRow | null> {
  const i = await getItem(kind, key, db);
  return i && !i.deletedAt && i.definition === "spec" ? row(i) : null;
}

/** What the agent runs: the enabled specs ({key, version, spec}). */
export const servedCustom = (kind: CustomKind) => servedSpecs(kind);

/** Create, or update the spec of, a crew or flow defined by a spec (the agent checks it first). */
export async function saveCustom(kind: CustomKind, actor: Actor, raw: unknown, deps: AgentDeps = {}): Promise<CustomRow> {
  const spec = (typeof raw === "object" && raw ? raw : {}) as Record<string, unknown>;
  const key = String(spec.key ?? "");
  const cur = /^[a-z][a-z0-9_]{1,39}$/.test(key) ? await getItem(kind, key) : null;
  if (cur && cur.definition !== "spec") throw new CatalogError(`${key} is not defined by a spec here; open it under ${kind === "crew" ? "Crews" : "Flows"}.`, 409);
  const item = cur ? await updateItem(kind, actor, key, { spec, label: spec.label ?? cur.label, description: spec.description ?? cur.description }, deps) : await createItem(kind, actor, { key, label: spec.label, description: spec.description, categories: ["custom"], spec }, deps);
  return row(item);
}

export async function setCustomEnabled(kind: CustomKind, actor: Actor, key: string, enabled: boolean): Promise<CustomRow> {
  return row(await setEnabled(kind, actor, key, enabled));
}

export async function deleteCustom(kind: CustomKind, actor: Actor, key: string): Promise<{ schedulesRemoved: number }> {
  const r = await deleteItem(kind, actor, key);
  return { schedulesRemoved: r.schedulesRemoved };
}

/** The kind in the address: crews or flows. */
export function kindOf(p: { kind: string }): CustomKind {
  if (p.kind === "crews") return "crew";
  if (p.kind === "flows") return "flow";
  throw new SeoApiError("Unknown kind.", 404, "not_found");
}

export function customApiError(e: unknown): never {
  if (e instanceof CatalogError) throw new SeoApiError(e.message, e.status, e.status === 422 ? "invalid" : e.status === 409 ? "conflict" : e.status === 404 ? "not_found" : e.status === 400 ? "invalid" : "unavailable", e.issues);
  throw e;
}
