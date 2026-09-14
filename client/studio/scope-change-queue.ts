export const SCOPE_CHANGE_SETTLE_MS = 1_000;

export type ScopeProjectId = string | null;
export type ScopeChangeSelection = "queued" | "cancelled" | "unchanged";

interface ScopeChangeScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface ScopeChangeQueue {
  select(
    canonicalProjectId: ScopeProjectId,
    targetProjectId: ScopeProjectId,
    commit: (projectId: ScopeProjectId) => void,
  ): ScopeChangeSelection;
  cancel(): void;
}

const systemScheduler: ScopeChangeScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Delays a Scope mutation until the selection settles. Returning to the
 * canonical Scope before the timer fires cancels the entire interaction, so
 * the server never creates recovery lineage for a quick accidental toggle.
 */
export function createScopeChangeQueue(
  delayMs = SCOPE_CHANGE_SETTLE_MS,
  scheduler: ScopeChangeScheduler = systemScheduler,
): ScopeChangeQueue {
  let handle: unknown | null = null;
  let pendingProjectId: ScopeProjectId | undefined;

  function cancel(): void {
    if (handle !== null) scheduler.cancel(handle);
    handle = null;
    pendingProjectId = undefined;
  }

  return {
    select(canonicalProjectId, targetProjectId, commit) {
      const hadPendingSelection = pendingProjectId !== undefined;
      cancel();
      if (targetProjectId === canonicalProjectId) {
        return hadPendingSelection ? "cancelled" : "unchanged";
      }
      pendingProjectId = targetProjectId;
      handle = scheduler.schedule(() => {
        const settledProjectId = pendingProjectId;
        handle = null;
        pendingProjectId = undefined;
        if (settledProjectId !== undefined) commit(settledProjectId);
      }, delayMs);
      return "queued";
    },
    cancel,
  };
}
