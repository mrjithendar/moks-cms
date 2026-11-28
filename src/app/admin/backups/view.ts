import { describeRun, type BackupRun } from "@/lib/backup/service";
import type { OperationView } from "./BackupActivity";

/** A backup_run row as the progress panel shows it. */
export function operationView(r: BackupRun): OperationView {
  return {
    id: r.id,
    operation: r.operation,
    label: describeRun(r),
    status: r.status,
    progress: r.progress,
    filename: r.filename,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    error: r.error,
    cancelRequested: r.cancelRequested,
  };
}
