import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { lstat } from "node:fs/promises";
import type { output as ZodOutput } from "zod";
import {
  catalogScanRpc,
  checkpointGetRpc,
  checkpointRestoreRpc,
  containerEnsureRpc,
  dispatchReconcileRpc,
  dispatchRetryRpc,
  dispatchSendRpc,
  dispatchPendingCountsRpc,
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
  type DispatchId,
  type DraftScope,
  type DraftScopeTarget,
  type Snapshot,
} from "../shared/contracts";
import {
  ensureAndRegisterInbox,
  ensureAndRegisterProjectContainer,
  type PaseoWorkspaceRegistrar,
} from "./project-registration";
import { createGenerationHandlers } from "./generation-handlers";
import { PromptStudioGenerationStore } from "./generation-store";
import type { ProjectLink } from "./storage/model";
import { formatError } from "./storage/filesystem";
import { PromptStudioStore } from "./store";
import { dispatchTimelineContains } from "./dispatch-matching";
import { appendDispatchProvenance } from "./dispatch-provenance";
import type { DispatchProvenanceRow } from "../shared/provenance";
import {
  projectLinkDeleteRpc,
  projectLinkMigrateRpc,
  projectLinksListRpc,
  type ProjectLinkStatus,
  type ProjectLinkSummary,
} from "../shared/project-links";

export interface ProjectLinkStatusesResult {
  links: ProjectLinkSummary[];
  verificationError: string | null;
}

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
    | { type: string; text?: unknown; messageId?: unknown; clientMessageId?: unknown };
  timestamp: string;
}

interface DispatchAgentHandle {
  id: string;
  workspaceId: string | null;
  current(): DispatchAgentSnapshot | null;
  refresh(requestId?: string): Promise<{ agent: DispatchAgentSnapshot } | null>;
  send(text: string, options?: { messageId?: string }): Promise<void>;
  timeline: {
    append(item: DispatchProvenanceRow): Promise<unknown>;
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

interface ActiveDispatchOperation {
  dispatchId: DispatchId;
  promise: Promise<Dispatch>;
}

const activeDispatchesByStore = new WeakMap<
  PromptStudioStore,
  Map<string, ActiveDispatchOperation>
>();

function runDispatchSingleFlight(
  store: PromptStudioStore,
  draftId: string,
  dispatchId: DispatchId,
  operation: () => Promise<Dispatch>,
): Promise<Dispatch> {
  let activeByDraft = activeDispatchesByStore.get(store);
  if (!activeByDraft) {
    activeByDraft = new Map();
    activeDispatchesByStore.set(store, activeByDraft);
  }
  const current = activeByDraft.get(draftId);
  if (current) {
    if (current.dispatchId === dispatchId) return current.promise;
    return Promise.reject(new Error("Another dispatch is already in progress for this Draft"));
  }

  const promise = Promise.resolve().then(operation);
  activeByDraft.set(draftId, { dispatchId, promise });
  void promise.then(
    () => {
      if (activeByDraft?.get(draftId)?.promise === promise) activeByDraft.delete(draftId);
    },
    () => {
      if (activeByDraft?.get(draftId)?.promise === promise) activeByDraft.delete(draftId);
    },
  );
  return promise;
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

export async function collectProjectLinkStatuses(
  store: PromptStudioStore,
  paseo: ProjectLinkPaseo,
): Promise<ProjectLinkStatusesResult> {
  let entries: ProjectLink[];
  try {
    entries = await store.listProjectLinks();
  } catch (error) {
    // A malformed map is already a scan warning; the status list reports the
    // same failure so Settings → Migration can explain and retry.
    return { links: [], verificationError: `local/project-map.json: ${formatError(error)}` };
  }
  const linked = entries.filter((entry): entry is ProjectLink & { source: NonNullable<ProjectLink["source"]> } => (
    Boolean(entry.source)
  ));

  const draftCounts = new Map<string, number>();
  try {
    const catalog = await store.scan("", null, null, false, null);
    for (const draft of catalog.drafts) {
      if (!draft.scope.projectId) continue;
      draftCounts.set(draft.scope.projectId, (draftCounts.get(draft.scope.projectId) ?? 0) + 1);
    }
  } catch {
    // Draft counts are informational; the status list still renders.
  }

  if (!linked.length) return { links: [], verificationError: null };

  let verificationError: string | null = null;
  const rootsByProject = new Map<string, string[]>();
  try {
    let cursor: string | undefined;
    let complete = false;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const page = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const workspace of page.entries) {
        const roots = rootsByProject.get(workspace.projectId) ?? [];
        roots.push(workspace.projectRootPath);
        rootsByProject.set(workspace.projectId, roots);
      }
      for (const project of page.emptyProjects ?? []) {
        const roots = rootsByProject.get(project.projectId) ?? [];
        roots.push(project.projectRootPath);
        rootsByProject.set(project.projectId, roots);
      }
      if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) {
        complete = true;
        break;
      }
      cursor = page.pageInfo.nextCursor;
    }
    if (!complete) {
      verificationError = "Paseo Project link verification exceeded the workspace pagination limit";
    }
  } catch (error) {
    verificationError = `Paseo Project links could not be verified: ${formatError(error)}`;
  }

  const links: ProjectLinkSummary[] = [];
  for (const entry of linked) {
    const source = entry.source;
    let status: ProjectLinkStatus;
    if (verificationError) {
      status = "unknown";
    } else {
      const currentRoots = rootsByProject.get(source.projectId);
      if (!currentRoots) {
        status = "project_missing";
      } else {
        let folderExists = false;
        for (const root of currentRoots) {
          try {
            if ((await lstat(root)).isDirectory()) folderExists = true;
          } catch {
            // Fall through to the next reported root.
          }
        }
        status = folderExists ? "available" : "folder_missing";
      }
    }
    links.push({
      containerId: entry.manifest.id,
      projectId: source.projectId,
      name: source.name,
      title: entry.manifest.title,
      rootPath: source.rootPath,
      status,
      draftCount: draftCounts.get(source.projectId) ?? 0,
    });
  }
  return { links, verificationError };
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
    const matched = dispatchTimelineContains(
      page.entries.map((entry) => entry.item),
      dispatch,
      snapshot,
    );
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
        const finalized = await store.finalizeDispatch(dispatch.draftId, dispatch.id, {
          status: "accepted",
          agentId,
          workspaceId: agent?.workspaceId ?? handle.workspaceId,
          agentTitle: agent?.title ?? null,
          provider: agent?.provider ?? null,
          userMessage: snapshot.markdown,
          reconciled: true,
        });
        await appendDispatchProvenance(store, handle, finalized, snapshot);
        return finalized;
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
      const finalized = await store.finalizeDispatch(dispatch.draftId, dispatch.id, {
        status: "accepted",
        agentId: handle.id,
        workspaceId: agent.workspaceId ?? handle.workspaceId,
        agentTitle: agent.title,
        provider: agent.provider,
        userMessage: snapshot.markdown,
      });
      await appendDispatchProvenance(store, handle, finalized, snapshot);
      return finalized;
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
    async send(
      draftId: string,
      target: ZodOutput<typeof dispatchSendRpc.input>["target"],
      dispatchId: DispatchId,
    ) {
      return runDispatchSingleFlight(store, draftId, dispatchId, async () => {
        const prepared = await store.prepareDispatch(draftId, target, dispatchId);
        if (!prepared.created) {
          if (prepared.dispatch.status !== "pending") return prepared.dispatch;
          return (await reconcile(prepared.dispatch, prepared.snapshot)) ?? prepared.dispatch;
        }
        return execute(prepared.dispatch, prepared.snapshot);
      });
    },

    async retry(draftId: string, dispatchId: DispatchId) {
      return runDispatchSingleFlight(store, draftId, dispatchId, async () => {
        const dispatch = await store.getDispatch(draftId, dispatchId);
        const snapshot = await store.getSnapshot(draftId, dispatch.snapshotId);
        if (dispatch.status === "accepted") return dispatch;
        const recovered = await reconcile(dispatch, snapshot);
        if (recovered) return recovered;
        if (dispatch.status === "pending") return dispatch;
        const claim = await store.claimDispatchAttempt(draftId, dispatchId);
        if (!claim.claimed) {
          return (await reconcile(claim.dispatch, snapshot)) ?? claim.dispatch;
        }
        return execute(claim.dispatch, snapshot);
      });
    },

    async reconcile(draftId: string, dispatchId: DispatchId) {
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
      // Project-link availability is intentionally absent here: broken links
      // are silent on Studio surfaces and are managed in Settings → Migration
      // through the structured project-link status RPC.
      const result = await store.scan(input.query, input.statuses, input.projectIds, input.rebuild, input.tagPaths);
      return {
        ...result,
        warnings: [...new Set([
          ...result.warnings,
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

    async projectLinksList(
      _input: ZodOutput<typeof projectLinksListRpc.input>,
      { paseo }: PluginHandlerContext,
    ) {
      return collectProjectLinkStatuses(store, paseo);
    },

    async projectLinkMigrate(
      input: ZodOutput<typeof projectLinkMigrateRpc.input>,
      { paseo }: PluginHandlerContext,
    ) {
      const ensured = await ensureForTarget(store, paseo, input.target);
      const movedDraftIds: string[] = [];
      const failures: Array<{ draftId: string; message: string }> = [];
      // Each move keeps the Store's per-Draft locks, scope checkpoint, and
      // optimistic checks, so a blocked Draft never hides successful moves and
      // retry is idempotent: already-moved Drafts no longer match the source.
      const source = await store.scan("", null, [input.sourceProjectId], false, null);
      for (const summary of source.drafts) {
        try {
          await store.moveDraftScope(summary.id, ensured.container.id, ensured.scope, { allowArchived: true });
          movedDraftIds.push(summary.id);
        } catch (error) {
          failures.push({ draftId: summary.id, message: formatError(error) });
        }
      }
      const remaining = (await store.scan("", null, [input.sourceProjectId], false, null)).drafts.length;
      const linkRemoved = failures.length === 0 && remaining === 0
        ? await store.removeProjectLink(input.sourceProjectId)
        : false;
      return { movedDraftIds, failures, linkRemoved };
    },

    async projectLinkDelete(input: ZodOutput<typeof projectLinkDeleteRpc.input>) {
      if (input.confirmationProjectId !== input.projectId) {
        throw new Error("Project deletion confirmation did not match the Project ID");
      }
      const deletedDraftIds: string[] = [];
      const failures: Array<{ draftId: string; message: string }> = [];
      // Permanent deletion reuses the ordinary archive-then-delete path with
      // its optimistic checks, dispatch gates, and per-Draft delete journal.
      const source = await store.scan("", null, [input.projectId], false, null);
      for (const summary of source.drafts) {
        try {
          let detail = await store.getDraft(summary.id);
          if (detail.summary.status !== "archived") {
            await store.transitionDraft({
              draftId: summary.id,
              targetStatus: "archived",
              expectedVersion: detail.summary.version,
              expectedHash: detail.summary.contentHash,
            });
            detail = await store.getDraft(summary.id);
          }
          await store.deleteDraft({
            draftId: summary.id,
            confirmationDraftId: summary.id,
            expectedVersion: detail.summary.version,
            expectedHash: detail.summary.contentHash,
          });
          deletedDraftIds.push(summary.id);
        } catch (error) {
          failures.push({ draftId: summary.id, message: formatError(error) });
        }
      }
      const remaining = (await store.scan("", null, [input.projectId], false, null)).drafts.length;
      const linkRemoved = failures.length === 0 && remaining === 0
        ? await store.removeProjectLink(input.projectId)
        : false;
      return { deletedDraftIds, failures, linkRemoved };
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
      const dispatch = await createDispatchCoordinator(store, paseo).send(
        input.draftId,
        input.target,
        input.dispatchId,
      );
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

    dispatchPendingCounts(input: ZodOutput<typeof dispatchPendingCountsRpc.input>) {
      return store.pendingDispatchCountsByProject(input.projectIds).then((counts) => ({ counts }));
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
