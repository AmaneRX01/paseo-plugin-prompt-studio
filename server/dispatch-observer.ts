import type {
  PluginLifecycleEvents,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import { dispatchTimelineContains } from "./dispatch-matching";
import { appendDispatchProvenance } from "./dispatch-provenance";
import type { PromptStudioStore } from "./store";

type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];

/**
 * Finalize Prompt Studio dispatches even when no plugin client is watching the
 * target Agent. The durable client message id and immutable snapshot text are
 * the only acceptance evidence used here.
 */
export function registerDispatchObserver(
  server: Pick<PluginServerContext, "on">,
  store: PromptStudioStore,
): () => void {
  return server.on("agent.turn_ended", async (event: TurnEndedEvent, { paseo }) => {
    try {
      const candidates = [
        ...(await store.pendingDispatchesForAgent(event.agent.id)),
        ...(event.agent.workspaceId
          ? await store.pendingDispatchesForWorkspace(event.agent.workspaceId)
          : []),
      ];
      const seen = new Set<string>();
      for (const dispatch of candidates) {
        if (seen.has(dispatch.id)) continue;
        seen.add(dispatch.id);
        const snapshot = await store.getSnapshot(dispatch.draftId, dispatch.snapshotId);
        if (!dispatchTimelineContains(event.timeline, dispatch, snapshot)) continue;
        const handle = paseo.agents.ref(event.agent.id);
        const finalized = await store.finalizeDispatch(dispatch.draftId, dispatch.id, {
          status: "accepted",
          agentId: event.agent.id,
          workspaceId: event.agent.workspaceId,
          agentTitle: event.agent.title,
          provider: event.agent.provider,
          userMessage: snapshot.markdown,
          reconciled: true,
        });
        await appendDispatchProvenance(store, handle, finalized, snapshot);
      }
    } catch (error) {
      // Lifecycle delivery must remain best-effort. A pending durable record is
      // intentionally left for the client RPC reconciliation path if anything
      // in the scan or finalization above fails.
      console.warn("Prompt Studio dispatch observer failed", error);
    }
  });
}
