import type { Dispatch, Snapshot } from "../shared/contracts";
import {
  createDispatchProvenanceRow,
  type DispatchProvenanceRow,
} from "../shared/provenance";

interface DispatchTimelineAppender {
  timeline: {
    append?: (item: DispatchProvenanceRow) => Promise<unknown>;
  };
}

const appendedByStore = new WeakMap<object, Set<string>>();
const failuresLoggedByStore = new WeakMap<object, Set<string>>();

/**
 * Append a stable host timeline row after durable dispatch acceptance. The
 * row is intentionally best-effort: failure to decorate a session must never
 * turn a successfully delivered dispatch into a failed one.
 */
export async function appendDispatchProvenance(
  storeKey: object,
  handle: DispatchTimelineAppender,
  dispatch: Dispatch,
  snapshot: Snapshot,
): Promise<void> {
  if (dispatch.status !== "accepted" || !dispatch.linkedSession) return;
  const append = handle.timeline.append;
  if (typeof append !== "function") return;

  let appended = appendedByStore.get(storeKey);
  if (!appended) {
    appended = new Set();
    appendedByStore.set(storeKey, appended);
  }
  if (appended.has(dispatch.id)) return;

  const row = createDispatchProvenanceRow({
    draftId: dispatch.draftId,
    draftTitle: snapshot.title,
    dispatchId: dispatch.id,
    revision: snapshot.version,
    sentAt: dispatch.linkedSession.acceptedAt,
  });
  try {
    await append.call(handle.timeline, row);
    appended.add(dispatch.id);
  } catch (error) {
    let failures = failuresLoggedByStore.get(storeKey);
    if (!failures) {
      failures = new Set();
      failuresLoggedByStore.set(storeKey, failures);
    }
    if (!failures.has(dispatch.id)) {
      failures.add(dispatch.id);
      console.warn(`Prompt Studio provenance append failed for ${dispatch.id}`, error);
    }
  }
}
