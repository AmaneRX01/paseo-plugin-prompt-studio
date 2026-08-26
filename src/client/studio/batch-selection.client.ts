import type { DraftSummary, DraftStatus } from "../../shared/contracts.shared";

export type BatchDraftAction = "set-draft" | "set-ready" | "archive" | "restore";

export interface PlannedDraftTransition {
  draftId: string;
  targetStatus: DraftStatus;
  expectedVersion: number;
  expectedHash: string;
}

function targetStatusForAction(
  draft: DraftSummary,
  action: BatchDraftAction,
): DraftStatus | null {
  if (action === "set-draft") return draft.status === "ready" ? "draft" : null;
  if (action === "set-ready") return draft.status === "draft" ? "ready" : null;
  if (action === "archive") return draft.status === "archived" ? null : "archived";
  return draft.status === "archived" ? draft.archivedFromStatus ?? "draft" : null;
}

/**
 * Plans only valid, non-no-op lifecycle transitions from the catalog snapshot.
 * The server still verifies each version and content hash before writing.
 */
export function planBatchDraftTransitions(
  drafts: readonly DraftSummary[],
  action: BatchDraftAction,
): PlannedDraftTransition[] {
  return drafts.flatMap((draft) => {
    const targetStatus = targetStatusForAction(draft, action);
    return targetStatus === null
      ? []
      : [{
          draftId: draft.id,
          targetStatus,
          expectedVersion: draft.version,
          expectedHash: draft.contentHash,
        }];
  });
}
