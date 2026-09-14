import { useMemo } from "react";
import type { Checkpoint, Snapshot } from "../../shared/contracts";
import { useClientPreference } from "../preferences-store";
import { createHostPreferenceStore, useHostPreferences } from "../preferences/host-preferences";

export const HISTORY_LIMIT_OPTIONS = [3, 5, 10, 20] as const;
export type HistoryLimit = (typeof HISTORY_LIMIT_OPTIONS)[number];

export interface HistoryPreferencesState {
  snapshotLimit: HistoryLimit;
  checkpointLimit: HistoryLimit;
  starredCheckpointsCountTowardLimit: boolean;
  checkpointStarsByDraft: Readonly<Record<string, readonly string[]>>;
}

export const LEGACY_STORAGE_KEY = "prompt-studio.history-preferences.v1";
const DRAFT_ID = /^dr_[a-f0-9]{16}$/;
const CHECKPOINT_ID = /^cp_[a-f0-9]{24}$/;

const historyStore = createHostPreferenceStore<HistoryPreferencesState>(
  (values): HistoryPreferencesState => ({
    snapshotLimit: values.snapshotLimit,
    checkpointLimit: values.checkpointLimit,
    starredCheckpointsCountTowardLimit: values.starredCheckpointsCountTowardLimit,
    checkpointStarsByDraft: values.checkpointStarsByDraft,
  }),
  (values, state) => ({
    ...values,
    snapshotLimit: state.snapshotLimit,
    checkpointLimit: state.checkpointLimit,
    starredCheckpointsCountTowardLimit: state.starredCheckpointsCountTowardLimit,
    checkpointStarsByDraft: Object.fromEntries(
      Object.entries(state.checkpointStarsByDraft).map(([draftId, checkpointIds]) => [draftId, [...checkpointIds]]),
    ),
  }),
);

function replaceState(nextState: HistoryPreferencesState) {
  historyStore.set(nextState);
}

export function getHistoryPreferences(): HistoryPreferencesState {
  return historyStore.getSnapshot();
}

export function setSnapshotLimit(snapshotLimit: HistoryLimit) {
  const current = historyStore.getSnapshot();
  if (snapshotLimit === current.snapshotLimit) return;
  replaceState({ ...current, snapshotLimit });
}

export function setCheckpointLimit(checkpointLimit: HistoryLimit) {
  const current = historyStore.getSnapshot();
  if (checkpointLimit === current.checkpointLimit) return;
  replaceState({ ...current, checkpointLimit });
}

export function setStarredCheckpointsCountTowardLimit(starredCheckpointsCountTowardLimit: boolean) {
  const current = historyStore.getSnapshot();
  if (starredCheckpointsCountTowardLimit === current.starredCheckpointsCountTowardLimit) return;
  replaceState({ ...current, starredCheckpointsCountTowardLimit });
}

export function toggleCheckpointStar(draftId: string, checkpointId: string) {
  if (!DRAFT_ID.test(draftId) || !CHECKPOINT_ID.test(checkpointId)) return;
  const state = historyStore.getSnapshot();
  const currentStars = state.checkpointStarsByDraft[draftId] ?? [];
  const next = currentStars.includes(checkpointId)
    ? currentStars.filter((id) => id !== checkpointId)
    : [...currentStars, checkpointId];
  const checkpointStarsByDraft = { ...state.checkpointStarsByDraft };
  if (next.length) checkpointStarsByDraft[draftId] = next;
  else delete checkpointStarsByDraft[draftId];
  replaceState({ ...state, checkpointStarsByDraft });
}

export function useHistoryPreferences(draftId?: string) {
  useHostPreferences();
  const state = useClientPreference(historyStore);
  const starredCheckpointIds = useMemo(
    () => new Set(draftId ? state.checkpointStarsByDraft[draftId] ?? [] : []),
    [draftId, state.checkpointStarsByDraft],
  );
  return { ...state, starredCheckpointIds };
}

function newestFirst<T>(values: readonly T[], at: (value: T) => string): T[] {
  return [...values].sort((left, right) => at(right).localeCompare(at(left)));
}

export function selectRecentSnapshots<T extends Pick<Snapshot, "createdAt">>(snapshots: readonly T[], limit: number): T[] {
  return newestFirst(snapshots, (snapshot) => snapshot.createdAt).slice(0, Math.max(0, limit));
}

export function selectVisibleCheckpoints(
  checkpoints: readonly Checkpoint[],
  starredCheckpointIds: ReadonlySet<string>,
  limit: number,
  starredCountTowardLimit: boolean,
): Checkpoint[] {
  const sorted = newestFirst(checkpoints, (checkpoint) => checkpoint.at);
  const starred = sorted.filter((checkpoint) => starredCheckpointIds.has(checkpoint.id));
  const unstarred = sorted.filter((checkpoint) => !starredCheckpointIds.has(checkpoint.id));
  const normalizedLimit = Math.max(0, limit);
  const selected = starredCountTowardLimit
    ? [...starred.slice(0, normalizedLimit), ...unstarred.slice(0, Math.max(0, normalizedLimit - starred.length))]
    : [...starred, ...unstarred.slice(0, normalizedLimit)];
  return newestFirst(selected, (checkpoint) => checkpoint.at);
}
