import {
  draftScopeSchema,
  draftStatusSchema,
  type DraftDetail,
  type DraftScope,
  type DraftStatus,
  type StudioEvent,
  type TimelineEntry,
} from "../shared/contracts.shared";

const LIFECYCLE_COLLAPSE_WINDOW_MS = 10_000;

function sameScope(left: DraftScope, right: DraftScope): boolean {
  return left.projectId === right.projectId;
}

function scopeLocation(scope: DraftScope): string {
  if (!scope.projectId) return "Inbox";
  return scope.projectName ?? scope.projectId;
}

function eventScope(event: StudioEvent, key: "sourceScope" | "targetScope" | "scope"): DraftScope | null {
  const parsed = draftScopeSchema.safeParse(event.details[key]);
  return parsed.success ? parsed.data : null;
}

function withinCollapseWindow(previous: StudioEvent, next: StudioEvent): boolean {
  return Date.parse(next.at) - Date.parse(previous.at) <= LIFECYCLE_COLLAPSE_WINDOW_MS;
}

function eventDraftStatus(value: unknown): DraftStatus | null {
  if (value === "starred") return "ready";
  const parsed = draftStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function lifecycleEntry(
  detail: DraftDetail,
  event: StudioEvent,
  type: "scope" | "status",
  summary: string,
): TimelineEntry {
  return {
    id: event.id,
    at: event.at,
    type,
    containerId: detail.summary.containerId,
    draftId: detail.summary.id,
    title: detail.summary.title,
    summary,
    agentId: null,
    dispatchId: null,
    snapshotId: null,
  };
}

function scopeTimeline(detail: DraftDetail): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  let previousScope: DraftScope | null = null;
  let batch: {
    last: StudioEvent;
    source: DraftScope | null;
    target: DraftScope;
  } | null = null;

  const flush = () => {
    if (!batch) return;
    if (!batch.source || !sameScope(batch.source, batch.target)) {
      timeline.push(lifecycleEntry(
        detail,
        batch.last,
        "scope",
        batch.source
          ? `Moved from ${scopeLocation(batch.source)} to ${scopeLocation(batch.target)}`
          : `Moved to ${scopeLocation(batch.target)}`,
      ));
    }
    batch = null;
  };

  const events = detail.events
    .filter((event) => event.type === "draft.scope-moved")
    .sort((left, right) => left.at.localeCompare(right.at));
  for (const event of events) {
    const target = eventScope(event, "targetScope") ?? eventScope(event, "scope");
    const source = eventScope(event, "sourceScope") ?? previousScope;
    if (!target) {
      flush();
      timeline.push(lifecycleEntry(detail, event, "scope", event.summary));
      continue;
    }
    if ((source && sameScope(source, target)) || (previousScope && sameScope(previousScope, target))) {
      previousScope = target;
      continue;
    }
    if (
      batch
      && withinCollapseWindow(batch.last, event)
      && (!source || sameScope(batch.target, source))
    ) {
      batch.last = event;
      batch.target = target;
    } else {
      flush();
      batch = { last: event, source, target };
    }
    previousScope = target;
  }
  flush();
  return timeline;
}

function statusTimeline(detail: DraftDetail): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  let batch: {
    last: StudioEvent;
    initialStatus: DraftStatus;
    finalStatus: DraftStatus;
  } | null = null;

  const flush = () => {
    if (!batch) return;
    if (batch.initialStatus !== batch.finalStatus) {
      const summary = batch.finalStatus === "archived"
        ? `Archived ${detail.summary.title}`
        : batch.initialStatus === "archived"
          ? `Restored ${detail.summary.title} as ${batch.finalStatus}`
          : `Changed ${detail.summary.title} from ${batch.initialStatus} to ${batch.finalStatus}`;
      timeline.push(lifecycleEntry(
        detail,
        batch.last,
        "status",
        summary,
      ));
    }
    batch = null;
  };

  const events = detail.events
    .filter((event) => event.type === "draft.status-changed" || event.type === "draft.archived")
    .sort((left, right) => left.at.localeCompare(right.at));
  let previousStatus: DraftStatus = "draft";
  for (const event of events) {
    const parsedFrom = eventDraftStatus(event.details.fromStatus);
    const parsedTo = eventDraftStatus(event.details.toStatus);
    const archived = event.details.archived;
    const fromStatus = parsedFrom
      ? parsedFrom
      : typeof archived === "boolean"
        ? archived ? previousStatus : "archived"
        : null;
    const toStatus = parsedTo
      ? parsedTo
      : typeof archived === "boolean"
        ? archived ? "archived" : "draft"
        : null;
    if (!fromStatus || !toStatus) {
      flush();
      timeline.push(lifecycleEntry(detail, event, "status", event.summary));
      continue;
    }
    if (batch && withinCollapseWindow(batch.last, event) && batch.finalStatus === fromStatus) {
      batch.last = event;
      batch.finalStatus = toStatus;
    } else {
      flush();
      batch = {
        last: event,
        initialStatus: fromStatus,
        finalStatus: toStatus,
      };
    }
    previousStatus = toStatus;
  }
  flush();
  return timeline;
}

export function buildDraftTimeline(detail: DraftDetail): TimelineEntry[] {
  const timeline: TimelineEntry[] = [{
    id: `draft-created:${detail.summary.id}`,
    at: detail.summary.createdAt,
    type: "draft",
    containerId: detail.summary.containerId,
    draftId: detail.summary.id,
    title: detail.summary.title,
    summary: detail.summary.preview,
    agentId: null,
    dispatchId: null,
    snapshotId: null,
  }];
  const latestContentEvent = detail.events.find(
    (event) => event.type === "draft.autosaved"
      || event.type === "draft.external-edit"
      || event.type === "checkpoint.restored"
      || event.type === "generation.applied",
  );
  if (latestContentEvent) {
    timeline.push({
      id: `draft-update:${detail.summary.id}`,
      at: latestContentEvent.at,
      type: "update",
      containerId: detail.summary.containerId,
      draftId: detail.summary.id,
      title: detail.summary.title,
      summary: latestContentEvent.summary,
      agentId: null,
      dispatchId: null,
      snapshotId: null,
    });
  }

  timeline.push(...scopeTimeline(detail), ...statusTimeline(detail));

  for (const event of detail.events.filter((candidate) => candidate.type.startsWith("generation."))) {
    timeline.push({
      id: event.id,
      at: event.at,
      type: "generation",
      containerId: detail.summary.containerId,
      draftId: detail.summary.id,
      title: detail.summary.title,
      summary: event.summary,
      agentId: typeof event.details.agentId === "string" ? event.details.agentId : null,
      dispatchId: null,
      snapshotId: null,
    });
  }

  const orderedDispatches = [...detail.dispatches].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const [dispatchIndex, dispatch] of orderedDispatches.entries()) {
    const snapshot = detail.snapshots.find((item) => item.id === dispatch.snapshotId);
    const resent = dispatchIndex > 0;
    timeline.push({
      id: dispatch.id,
      at: dispatch.updatedAt,
      type: dispatch.status === "pending" ? "pending" : dispatch.status === "accepted" ? "sent" : "failed",
      containerId: detail.summary.containerId,
      draftId: detail.summary.id,
      title: dispatch.status === "pending"
        ? `${resent ? "Re-send" : "Send"} pending: ${detail.summary.title}`
        : dispatch.status === "accepted"
          ? `${resent ? "Re-sent" : "Sent"} ${detail.summary.title}`
          : `Failed ${detail.summary.title}`,
      summary: dispatch.error
        ?? `Snapshot ${dispatch.snapshotId}${snapshot ? ` · v${snapshot.version}` : ""} · ${dispatch.clientMessageId}`,
      agentId: dispatch.agentId,
      dispatchId: dispatch.id,
      snapshotId: dispatch.snapshotId,
    });
    if (dispatch.linkedSession) {
      timeline.push({
        id: `session:${dispatch.id}`,
        at: dispatch.linkedSession.acceptedAt,
        type: "session",
        containerId: detail.summary.containerId,
        draftId: detail.summary.id,
        title: dispatch.linkedSession.agentTitle ?? `Agent ${dispatch.linkedSession.agentId}`,
        summary: dispatch.linkedSession.userMessage.slice(0, 240),
        agentId: dispatch.linkedSession.agentId,
        dispatchId: dispatch.id,
        snapshotId: dispatch.snapshotId,
      });
    }
  }
  return timeline;
}
