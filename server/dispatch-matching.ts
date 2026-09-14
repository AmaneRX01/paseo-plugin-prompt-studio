import type { Dispatch, Snapshot } from "../shared/contracts";

export interface DispatchTimelineMessageLike {
  type?: unknown;
  text?: unknown;
  messageId?: unknown;
  clientMessageId?: unknown;
}

/**
 * A delivery is accepted only when the canonical user message has both the
 * immutable snapshot text and the durable client message identity. This keeps
 * reconciliation from mistaking an edited or similarly-worded turn for the
 * dispatch being recovered.
 */
export function dispatchTimelineItemMatches(
  item: unknown,
  dispatch: Pick<Dispatch, "clientMessageId">,
  snapshot: Pick<Snapshot, "markdown">,
): boolean {
  if (!item || typeof item !== "object") return false;
  const message = item as DispatchTimelineMessageLike;
  return (
    message.type === "user_message"
    && message.text === snapshot.markdown
    && (message.clientMessageId === dispatch.clientMessageId || message.messageId === dispatch.clientMessageId)
  );
}

export function dispatchTimelineContains(
  items: readonly unknown[],
  dispatch: Pick<Dispatch, "clientMessageId">,
  snapshot: Pick<Snapshot, "markdown">,
): boolean {
  return items.some((item) => dispatchTimelineItemMatches(item, dispatch, snapshot));
}

// Keep the name descriptive at call sites that are checking a complete
// timeline page, while retaining one implementation for the lifecycle hook
// and the RPC reconciliation path.
export const timelineContainsDispatch = dispatchTimelineContains;
