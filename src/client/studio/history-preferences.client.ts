import { useMemo, useSyncExternalStore } from "react";
import type { Checkpoint, Snapshot } from "../../shared/contracts.shared";

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
    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(STORAGE_KEY);
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

let currentState = readInitialState();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function replaceState(nextState: HistoryPreferencesState) {
  currentState = nextState;
  try {
    (globalThis as { localStorage?: Storage }).localStorage?.setItem(STORAGE_KEY, JSON.stringify(nextState));
  } catch {
    // Persistence is best-effort on native runtimes without web storage.
  }
  emit();
}

export function getHistoryPreferences(): HistoryPreferencesState {
  return currentState;
}

export function setSnapshotLimit(snapshotLimit: HistoryLimit) {
  if (snapshotLimit === currentState.snapshotLimit) return;
  replaceState({ ...currentState, snapshotLimit });
}

export function setCheckpointLimit(checkpointLimit: HistoryLimit) {
  if (checkpointLimit === currentState.checkpointLimit) return;
  replaceState({ ...currentState, checkpointLimit });
}

export function setStarredCheckpointsCountTowardLimit(starredCheckpointsCountTowardLimit: boolean) {
  if (starredCheckpointsCountTowardLimit === currentState.starredCheckpointsCountTowardLimit) return;
  replaceState({ ...currentState, starredCheckpointsCountTowardLimit });
}

export function toggleCheckpointStar(draftId: string, checkpointId: string) {
  if (!DRAFT_ID.test(draftId) || !CHECKPOINT_ID.test(checkpointId)) return;
  const current = currentState.checkpointStarsByDraft[draftId] ?? [];
  const next = current.includes(checkpointId)
    ? current.filter((id) => id !== checkpointId)
    : [...current, checkpointId];
  const checkpointStarsByDraft = { ...currentState.checkpointStarsByDraft };
  if (next.length) checkpointStarsByDraft[draftId] = next;
  else delete checkpointStarsByDraft[draftId];
  replaceState({ ...currentState, checkpointStarsByDraft });
}

export function useHistoryPreferences(draftId?: string) {
  const state = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getHistoryPreferences,
    getHistoryPreferences,
  );
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
