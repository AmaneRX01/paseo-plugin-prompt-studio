import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { output as ZodOutput } from "zod";
import {
  catalogScanRpc,
  checkpointGetRpc,
  checkpointRestoreRpc,
  containerEnsureRpc,
  dispatchReconcileRpc,
  dispatchRetryRpc,
  dispatchSendRpc,
  draftAutosaveRpc,
  draftBatchTransitionRpc,
  draftCreateRpc,
  draftDeleteRpc,
  draftGetRpc,
  draftScopeRpc,
  draftTagsSetRpc,
  draftTransitionRpc,
  snapshotGetRpc,
  tagBatchRpc,
  tagRenameRpc,
  type ContainerId,
  type Dispatch,
  type DraftScope,
  type DraftScopeTarget,
  type Snapshot,
} from "../shared/contracts.shared";
import {
  ensureAndRegisterInbox,
  ensureAndRegisterProjectContainer,
  type PaseoWorkspaceRegistrar,
} from "./project-registration.server";
import { createGenerationHandlers } from "./generation-handlers.server";
import { PromptStudioGenerationStore } from "./generation-store.server";
import { formatError, normalizePath } from "./storage/filesystem.server";
import { PromptStudioStore, type ResolvedSourceProject } from "./store.server";

interface DispatchAgentSnapshot {
  id: string;
  workspaceId?: string;
  provider: string;
  title: string | null;
  archivedAt?: string | null;
}

interface DispatchTimelineEntry {
  item:
    | { type: "user_message"; text: string; messageId?: string; clientMessageId?: string }
    | { type: string; [key: string]: unknown };
  timestamp: string;
}

interface DispatchAgentHandle {
  id: string;
  workspaceId: string | null;
  current(): DispatchAgentSnapshot | null;
  refresh(requestId?: string): Promise<{ agent: DispatchAgentSnapshot } | null>;
  send(text: string, options?: { messageId?: string }): Promise<void>;
  timeline: {
    refetch(options?: {
      direction?: "tail" | "before" | "after";
      cursor?: { epoch: string; seq: number };
      limit?: number;
      projection?: "projected" | "canonical";
    }): Promise<{
      entries: DispatchTimelineEntry[];
      startCursor: { epoch: string; seq: number } | null;
      hasOlder: boolean;
      error: string | null;
    }>;
  };
}

interface DispatchWorkspaceSnapshot {
  id: string;
  projectId: string;
  projectRootPath: string;
  workspaceDirectory?: string;
}

interface DispatchWorkspaceHandle {
  id: string;
  refresh(options?: { requestId?: string }): Promise<DispatchWorkspaceSnapshot | null>;
  agents: {
    create(options: {
      config: {
        provider: string;
        modeId?: string;
        thinkingOptionId?: string;
      };
      prompt: string;
      requestId: string;
      clientMessageId: string;
      title?: string;
      labels?: Record<string, string>;
    }): Promise<DispatchAgentHandle>;
  };
}

export interface DispatchPaseo {
  agents: {
    ref(agentId: string): DispatchAgentHandle;
    list(options?: {
      filter?: { includeArchived?: boolean };
      page?: { limit: number; cursor?: string };
    }): Promise<{
      entries: Array<{ agent: DispatchAgentSnapshot }>;
      pageInfo: { nextCursor: string | null; hasMore: boolean };
    }>;
  };
  workspaces: {
    ref(workspaceId: string): DispatchWorkspaceHandle;
  };
}

export interface ProjectLinkPaseo {
  workspaces: {
    list(options: { page: { limit: number; cursor?: string } }): Promise<{
      entries: Array<{ projectId: string; projectRootPath: string }>;
      emptyProjects?: Array<{ projectId: string; projectRootPath: string }>;
      pageInfo: { nextCursor: string | null; hasMore: boolean };
    }>;
  };
}

export async function projectLinkWarnings(
  store: PromptStudioStore,
  paseo: ProjectLinkPaseo,
): Promise<string[]> {
  let links: ResolvedSourceProject[];
  try {
    links = await store.getLinkedProjects();
  } catch {
    // The canonical scan already reports a malformed project map.
    return [];
  }
  if (!links.length) return [];
  try {
    const rootsByProject = new Map<string, Set<string>>();
    let cursor: string | undefined;
    let complete = false;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const page = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const workspace of page.entries) {
        const roots = rootsByProject.get(workspace.projectId) ?? new Set<string>();
        roots.add(normalizePath(workspace.projectRootPath));
        rootsByProject.set(workspace.projectId, roots);
      }
      for (const project of page.emptyProjects ?? []) {
        const roots = rootsByProject.get(project.projectId) ?? new Set<string>();
        roots.add(normalizePath(project.projectRootPath));
        rootsByProject.set(project.projectId, roots);
      }
      if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) {
        complete = true;
        break;
      }
      cursor = page.pageInfo.nextCursor;
    }
    if (!complete) return ["Paseo Project link verification exceeded the workspace pagination limit"];
    return links.flatMap((link) => {
      const roots = rootsByProject.get(link.projectId);
      if (!roots) {
        return [`${link.name}: linked Paseo Project ${link.projectId} is unavailable; Drafts were retained`];
      }
      if (!roots.has(normalizePath(link.rootPath))) {
        return [`${link.name}: linked Paseo Project now points to a different folder; Drafts were retained`];
      }
      return [];
    });
  } catch (error) {
    return [`Paseo Project links could not be verified: ${formatError(error)}`];
  }
}

async function ensureForTarget(
  store: PromptStudioStore,
  paseo: PaseoWorkspaceRegistrar,
  target: DraftScopeTarget,
) {
  if (target.kind === "inbox") {
    const ensured = await ensureAndRegisterInbox(store, paseo);
    return {
      ...ensured,
      scope: { projectId: null, projectName: null } satisfies DraftScope,
    };
  }
  const ensured = await ensureAndRegisterProjectContainer(store, paseo, target.projectId);
  if (ensured.container.containerType === "inbox") {
    return {
      ...ensured,
      scope: { projectId: null, projectName: null } satisfies DraftScope,
    };
  }
  const source = await store.getContainerSource(ensured.container.id);
  const canonicalScope: DraftScope = source
    ? {
        projectId: source.projectId,
        projectName: source.name,
      }
    : {
        projectId: target.projectId,
        projectName: ensured.container.sourceProjectName,
      };
  return { ...ensured, scope: canonicalScope };
}

async function retryContainerRegistration(
  store: PromptStudioStore,
  paseo: PaseoWorkspaceRegistrar,
  containerId: ContainerId,
) {
  if (containerId === "ct_inbox") return ensureAndRegisterInbox(store, paseo);
  const source = await store.getContainerSource(containerId);
  if (!source) throw new Error(`Project link is unavailable for container ${containerId}`);
  return ensureAndRegisterProjectContainer(store, paseo, source.projectId);
}

async function agentSnapshot(handle: DispatchAgentHandle): Promise<DispatchAgentSnapshot> {
  const refreshed = await handle.refresh();
  if (!refreshed) throw new Error(`Paseo agent is unavailable: ${handle.id}`);
  if (refreshed.agent.archivedAt) throw new Error(`Paseo agent is archived: ${handle.id}`);
  return refreshed.agent;
}

function createdAgentSnapshot(
  handle: DispatchAgentHandle,
  expectedWorkspaceId: string,
): DispatchAgentSnapshot {
  const agent = handle.current();
  if (!agent) throw new Error(`Paseo did not return the created Agent snapshot: ${handle.id}`);
  if (agent.id !== handle.id) {
    throw new Error(`Paseo returned a mismatched Agent snapshot for ${handle.id}`);
  }
  if ((agent.workspaceId ?? handle.workspaceId) !== expectedWorkspaceId) {
    throw new Error(`Paseo created Agent ${handle.id} in an unexpected Workspace`);
  }
  if (agent.archivedAt) throw new Error(`Paseo agent is archived: ${handle.id}`);
  return agent;
}

async function timelineContains(
  handle: DispatchAgentHandle,
  dispatch: Dispatch,
  snapshot: Snapshot,
): Promise<boolean> {
  let cursor: { epoch: string; seq: number } | undefined;
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await handle.timeline.refetch({
      direction: cursor ? "before" : "tail",
      cursor,
      limit: 200,
      projection: "canonical",
    });
    if (page.error) throw new Error(page.error);
    const matched = page.entries.some((entry) => {
      const item = entry.item;
      return (
        item.type === "user_message" &&
        item.text === snapshot.markdown &&
        (item.clientMessageId === dispatch.clientMessageId || item.messageId === dispatch.clientMessageId)
      );
    });
    if (matched) return true;
    if (!page.hasOlder || !page.startCursor) return false;
    cursor = page.startCursor;
  }
  return false;
}

async function candidateAgentIds(paseo: DispatchPaseo, dispatch: Dispatch): Promise<string[]> {
  if (dispatch.target.kind === "existing_agent") return [dispatch.target.agentId];
  if (dispatch.agentId) return [dispatch.agentId];
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await paseo.agents.list({
      filter: { includeArchived: true },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const entry of page.entries) {
      if (entry.agent.workspaceId === dispatch.target.workspaceId) ids.push(entry.agent.id);
    }
    if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) break;
    cursor = page.pageInfo.nextCursor;
  }
  return ids;
}

export function createDispatchCoordinator(store: PromptStudioStore, paseo: DispatchPaseo) {
  async function reconcile(dispatch: Dispatch, snapshot: Snapshot): Promise<Dispatch | null> {
    for (const agentId of await candidateAgentIds(paseo, dispatch)) {
      const handle = paseo.agents.ref(agentId);
      try {
        if (!(await timelineContains(handle, dispatch, snapshot))) continue;
        const current = await handle.refresh();
        const agent = current?.agent ?? null;
        return store.finalizeDispatch(dispatch.draftId, dispatch.id, {
          status: "accepted",
          agentId,
          workspaceId: agent?.workspaceId ?? handle.workspaceId,
          agentTitle: agent?.title ?? null,
          provider: agent?.provider ?? null,
          userMessage: snapshot.markdown,
          reconciled: true,
        });
      } catch {
        // One inaccessible/deleted candidate must not hide another matching session.
      }
    }
    return null;
  }

  async function execute(dispatch: Dispatch, snapshot: Snapshot): Promise<Dispatch> {
    try {
      let handle: DispatchAgentHandle;
      let agent: DispatchAgentSnapshot;
      if (dispatch.target.kind === "existing_agent") {
        handle = paseo.agents.ref(dispatch.target.agentId);
        agent = await agentSnapshot(handle);
        await handle.send(snapshot.markdown, { messageId: dispatch.clientMessageId });
      } else {
        const workspace = paseo.workspaces.ref(dispatch.target.workspaceId);
        const workspaceSnapshot = await workspace.refresh();
        if (!workspaceSnapshot) throw new Error(`Paseo workspace is unavailable: ${dispatch.target.workspaceId}`);
        if (
          (await store.isManagedPath(workspaceSnapshot.projectRootPath)) ||
          (workspaceSnapshot.workspaceDirectory && (await store.isManagedPath(workspaceSnapshot.workspaceDirectory)))
        ) {
          throw new Error("New agents cannot run inside the managed Prompt Studio Project");
        }
        const provider = `${dispatch.target.config.provider}/${dispatch.target.config.model}`;
        handle = await workspace.agents.create({
          config: {
            provider,
            ...(dispatch.target.config.modeId ? { modeId: dispatch.target.config.modeId } : {}),
            ...(dispatch.target.config.thinkingOptionId
              ? { thinkingOptionId: dispatch.target.config.thinkingOptionId }
              : {}),
          },
          prompt: snapshot.markdown,
          requestId: dispatch.id,
          clientMessageId: dispatch.clientMessageId,
          ...(dispatch.target.config.title ? { title: dispatch.target.config.title } : {}),
          labels: {
            "prompt-studio.dispatch": dispatch.id,
            "prompt-studio.snapshot": dispatch.snapshotId,
          },
        });
        // create() already returns a handle seeded with the daemon's authoritative
        // Agent snapshot. An immediate refresh can race the daemon's fetch index and
        // turn a successful creation into a false "Agent not found" failure.
        agent = createdAgentSnapshot(handle, dispatch.target.workspaceId);
      }
      return await store.finalizeDispatch(dispatch.draftId, dispatch.id, {
        status: "accepted",
        agentId: handle.id,
        workspaceId: agent.workspaceId ?? handle.workspaceId,
        agentTitle: agent.title,
        provider: agent.provider,
        userMessage: snapshot.markdown,
      });
    } catch (error) {
      const recovered = await reconcile(dispatch, snapshot).catch(() => null);
      if (recovered) return recovered;
      return store.finalizeDispatch(dispatch.draftId, dispatch.id, {
        status: "failed",
        error: formatError(error),
        agentId: dispatch.agentId,
        workspaceId: dispatch.workspaceId,
      });
    }
  }

  return {
    async send(draftId: string, target: ZodOutput<typeof dispatchSendRpc.input>["target"]) {
      const prepared = await store.prepareDispatch(draftId, target);
      return execute(prepared.dispatch, prepared.snapshot);
    },

    async retry(draftId: string, dispatchId: string) {
      let dispatch = await store.getDispatch(draftId, dispatchId);
      const snapshot = await store.getSnapshot(draftId, dispatch.snapshotId);
      if (dispatch.status === "accepted") return dispatch;
      const recovered = await reconcile(dispatch, snapshot);
      if (recovered) return recovered;
      dispatch = await store.markDispatchAttempt(draftId, dispatchId);
      return execute(dispatch, snapshot);
    },

    async reconcile(draftId: string, dispatchId: string) {
      const dispatch = await store.getDispatch(draftId, dispatchId);
      if (dispatch.status === "accepted") return dispatch;
      const snapshot = await store.getSnapshot(draftId, dispatch.snapshotId);
      return (await reconcile(dispatch, snapshot)) ?? dispatch;
    },
  };
}

export function createHandlers(store = new PromptStudioStore()) {
  return {
    async catalogScan(
      input: ZodOutput<typeof catalogScanRpc.input>,
      { paseo }: PluginHandlerContext,
    ) {
      let registrationWarning: string | null = null;
      try {
        registrationWarning = (await ensureAndRegisterInbox(store, paseo)).registrationWarning;
      } catch (error) {
        registrationWarning = `Prompt Studio vault registration could not be checked: ${formatError(error)}`;
      }
      const result = await store.scan(input.query, input.statuses, input.projectIds, input.rebuild, input.tagPaths);
      const linkWarnings = await projectLinkWarnings(store, paseo);
      return {
        ...result,
        warnings: [...new Set([
          ...result.warnings,
          ...linkWarnings,
          ...(registrationWarning ? [registrationWarning] : []),
        ])],
      };
    },

    async containerEnsure(
      input: ZodOutput<typeof containerEnsureRpc.input>,
      { paseo }: PluginHandlerContext,
    ) {
      if (input.kind === "inbox") return ensureAndRegisterInbox(store, paseo);
      if (input.kind === "project") {
        return ensureAndRegisterProjectContainer(store, paseo, input.projectId);
      }
      return retryContainerRegistration(store, paseo, input.containerId);
    },

    async draftCreate(input: ZodOutput<typeof draftCreateRpc.input>, { paseo }: PluginHandlerContext) {
      const ensured = await ensureForTarget(store, paseo, input.target);
      const draft = await store.createDraft(ensured.container.id, ensured.scope, input.title, input.markdown);
      return { draft, registrationWarning: ensured.registrationWarning };
    },

    draftGet(input: ZodOutput<typeof draftGetRpc.input>) {
      return store.getDraft(input.draftId).then((draft) => ({ draft }));
    },

    draftAutosave(input: ZodOutput<typeof draftAutosaveRpc.input>) {
      return store.autosaveDraft(input);
    },

    draftTagsSet(input: ZodOutput<typeof draftTagsSetRpc.input>) {
      return store.setDraftTags(input);
    },

    tagRename(input: ZodOutput<typeof tagRenameRpc.input>) {
      return store.renameTag(input.fromPath, input.toPath);
    },

    tagBatch(input: ZodOutput<typeof tagBatchRpc.input>) {
      return store.batchDraftTags(input);
    },

    async draftScope(input: ZodOutput<typeof draftScopeRpc.input>, { paseo }: PluginHandlerContext) {
      const ensured = await ensureForTarget(store, paseo, input.target);
      const draft = await store.moveDraftScope(input.draftId, ensured.container.id, ensured.scope);
      return { draft, registrationWarning: ensured.registrationWarning };
    },

    draftTransition(input: ZodOutput<typeof draftTransitionRpc.input>) {
      return store.transitionDraft(input);
    },

    async draftBatchTransition(input: ZodOutput<typeof draftBatchTransitionRpc.input>) {
      const changedDrafts = [];
      const unchangedDraftIds: string[] = [];
      const failures: Array<{ draftId: string; message: string }> = [];

      // Each transition keeps the Store's ordinary optimistic checks and locks.
      // A stale or blocked Draft does not prevent independent selected Drafts
      // from completing; callers receive every partial failure explicitly.
      for (const transition of input.transitions) {
        try {
          const result = await store.transitionDraft(transition);
          if (result.changed) changedDrafts.push(result.draft.summary);
          else unchangedDraftIds.push(transition.draftId);
        } catch (error) {
          failures.push({ draftId: transition.draftId, message: formatError(error) });
        }
      }

      return { changedDrafts, unchangedDraftIds, failures };
    },

    draftDelete(input: ZodOutput<typeof draftDeleteRpc.input>) {
      return store.deleteDraft(input);
    },

    snapshotGet(input: ZodOutput<typeof snapshotGetRpc.input>) {
      return store.getSnapshot(input.draftId, input.snapshotId).then((snapshot) => ({ snapshot }));
    },

    checkpointGet(input: ZodOutput<typeof checkpointGetRpc.input>) {
      return store.getCheckpoint(input.draftId, input.checkpointId).then((checkpoint) => ({ checkpoint }));
    },

    checkpointRestore(input: ZodOutput<typeof checkpointRestoreRpc.input>) {
      return store.restoreCheckpoint(input);
    },

    async dispatchSend(input: ZodOutput<typeof dispatchSendRpc.input>, { paseo }: PluginHandlerContext) {
      const dispatch = await createDispatchCoordinator(store, paseo).send(input.draftId, input.target);
      return { draft: await store.getDraft(input.draftId), dispatch };
    },

    async dispatchRetry(input: ZodOutput<typeof dispatchRetryRpc.input>, { paseo }: PluginHandlerContext) {
      const dispatch = await createDispatchCoordinator(store, paseo).retry(input.draftId, input.dispatchId);
      return { draft: await store.getDraft(input.draftId), dispatch };
    },

    async dispatchReconcile(
      input: ZodOutput<typeof dispatchReconcileRpc.input>,
      { paseo }: PluginHandlerContext,
    ) {
      const dispatch = await createDispatchCoordinator(store, paseo).reconcile(input.draftId, input.dispatchId);
      return { draft: await store.getDraft(input.draftId), dispatch };
    },
  };
}

// Paseo 0.5.1 bundles client and server halves separately. Keep this singleton at module scope;
// index.ts must reference these properties inside plugin.handle(...) and must not call the factory.
export const promptStudioStore = new PromptStudioStore();
export const handlers = createHandlers(promptStudioStore);
export const generationHandlers = createGenerationHandlers(
  new PromptStudioGenerationStore(promptStudioStore),
);
