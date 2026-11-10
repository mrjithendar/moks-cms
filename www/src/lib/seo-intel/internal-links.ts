import type { Db } from "@/db";
import type { BaseSnapshot, Change } from "./changeset";
import type { SeoSettings } from "./settings";

/** Phase 4 fills this in: conservative, rule-based internal links proposed as draft changes. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub until Phase 4
export async function linkChangesFor(_db: Db, _s: SeoSettings, _base: BaseSnapshot, _articleId: string, _evidence: string[], _startAt: number): Promise<Change[]> {
  return [];
}
