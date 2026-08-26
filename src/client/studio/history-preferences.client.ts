import { useMemo } from "react";
import type { Checkpoint, Snapshot } from "../../shared/contracts.shared";
import {
  createClientPreferenceStore,
  readClientStorage,
  useClientPreference,
  writeClientStorage,
} from "../preferences-store.client";

export const HISTORY_LIMIT_OPTIONS = [3, 5, 10, 20] as const;
export type HistoryLimit = (typeof HISTORY_LIMIT_OPTIONS)[number];

interface HistoryPreferencesState {
  snapshotLimit: HistoryLimit;
  checkpointLimit: HistoryLimit;
  starredCheckpointsCountTowardLimit: boolean;
  checkpointStarsByDraft: Readonly<Record<string, readonly string[]>>;
}

const STORAGE_KEY = "prompt-studio.history-preferences.v1";
const DEFAULT_STATE: HistoryPreferencesState = {
  snapshotLimit: 5,
  checkpointLimit: 5,
  starredCheckpointsCountTowardLimit: true,
  checkpointStarsByDraft: {},
};
const DRAFT_ID = /^dr_[a-f0-9]{16}$/;
const CHECKPOINT_ID = /^cp_[a-f0-9]{24}$/;

function isHistoryLimit(value: unknown): value is HistoryLimit {
  return typeof value === "number" && HISTORY_LIMIT_OPTIONS.some((option) => option === value);
}

function readInitialState(): HistoryPreferencesState {
  try {
    const raw = readClientStorage(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rawStars = parsed.checkpointStarsByDraft;
    const checkpointStarsByDraft: Record<string, readonly string[]> = {};
    if (rawStars && typeof rawStars === "object" && !Array.isArray(rawStars)) {
      for (const [draftId, checkpointIds] of Object.entries(rawStars as Record<string, unknown>)) {
        if (!DRAFT_ID.test(draftId) || !Array.isArray(checkpointIds)) continue;
        checkpointStarsByDraft[draftId] = [...new Set(
          checkpointIds.filter((checkpointId): checkpointId is string =>
            typeof checkpointId === "string" && CHECKPOINT_ID.test(checkpointId),
          ),
        )];
      }
    }
    return {
      snapshotLimit: isHistoryLimit(parsed.snapshotLimit) ? parsed.snapshotLimit : DEFAULT_STATE.snapshotLimit,
      checkpointLimit: isHistoryLimit(parsed.checkpointLimit) ? parsed.checkpointLimit : DEFAULT_STATE.checkpointLimit,
      starredCheckpointsCountTowardLimit:
        typeof parsed.starredCheckpointsCountTowardLimit === "boolean"
          ? parsed.starredCheckpointsCountTowardLimit
          : DEFAULT_STATE.starredCheckpointsCountTowardLimit,
      checkpointStarsByDraft,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

const historyStore = createClientPreferenceStore(
  readInitialState(),
  (state) => writeClientStorage(STORAGE_KEY, JSON.stringify(state)),
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
