export const activeDraftStatuses = ["draft", "ready"] as const;
export const draftStatuses = [...activeDraftStatuses, "archived"] as const;

export type ActiveDraftStatus = (typeof activeDraftStatuses)[number];
export type DraftStatus = (typeof draftStatuses)[number];

export function isActiveDraftStatus(status: DraftStatus): status is ActiveDraftStatus {
  return status !== "archived";
}

export function isSendableDraftStatus(status: DraftStatus): boolean {
  return status === "ready";
}

export function canTransitionDraftStatus(
  current: DraftStatus,
  target: DraftStatus,
  archivedFromStatus: ActiveDraftStatus | null,
): boolean {
  if (current === target) return true;
  if (current === "archived") return target === (archivedFromStatus ?? "draft");
  if (target === "archived") return true;
  if (current === "draft") return target === "ready";
  return target === "draft";
}
