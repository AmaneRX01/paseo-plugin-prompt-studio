import type { PaseoAgent } from "@getpaseo/client";
import type {
  PluginButtonRegistration,
  PluginButtonIconProps,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginCleanup } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { defaultShortcutVisibilitySource, type ShortcutVisibilitySource } from "./preferences/shortcut-visibility";
import { dispatchPendingCountsRpc, draftCreateRpc } from "../shared/contracts";
import {
  applyWorkspaceDirectoryUpdate,
  fetchWorkspaceDirectory,
  normalizeWorkspaceDirectoryUpdate,
  type WorkspaceDirectoryEntry,
  type WorkspaceDirectorySnapshot,
  type WorkspaceDirectoryUpdate,
} from "./studio/workspace-directory-state";

export const PENDING_DISPATCH_COUNTS_QUERY_KEY = [
  "prompt-studio",
  "dispatch-pending-counts",
] as const;

export function pendingDispatchCountsQueryKey(projectId: string) {
  return [...PENDING_DISPATCH_COUNTS_QUERY_KEY, projectId] as const;
}

const PENDING_COUNT_REFRESH_MS = 15_000;
const AGENT_PAGE_LIMIT = 200;
const MAX_AGENT_PAGES = 20;

type RegistrationRef = { current: PluginButtonRegistration | null };

function pendingCountIcon(
  client: PluginClientContext,
  projectId: string,
  baseLabel: string,
  registration: RegistrationRef,
) {
  return function PendingCountIcon({ size, color }: PluginButtonIconProps) {
    const query = useQuery({
      queryKey: pendingDispatchCountsQueryKey(projectId),
      queryFn: () => client.rpc(dispatchPendingCountsRpc, { projectIds: [projectId] }),
      staleTime: PENDING_COUNT_REFRESH_MS,
      refetchInterval: PENDING_COUNT_REFRESH_MS,
      retry: 1,
    });
    const count = query.data?.counts[projectId] ?? 0;
    useEffect(() => {
      registration.current?.update({
        label: count > 0 ? `${baseLabel} · ${count}` : baseLabel,
      });
    }, [baseLabel, count, registration]);
    return <Icon color={color} name="FileText" size={size} />;
  };
}

interface WorkspaceRegistration {
  projectId: string;
  registration: PluginButtonRegistration;
  ref: RegistrationRef;
}

interface AgentRegistration {
  workspaceId: string;
  registration: PluginButtonRegistration;
}

function activeAgent(value: PaseoAgent): value is PaseoAgent & { workspaceId: string } {
  return Boolean(value.id && value.workspaceId && !value.archivedAt);
}

/** Register all entry-point actions in one disposable, target-keyed owner. */
export function registerClientActions(client: PluginClientContext, visibility: ShortcutVisibilitySource = defaultShortcutVisibilitySource): PluginCleanup {
  const workspaceRegistrations = new Map<string, WorkspaceRegistration>();
  const agentRegistrations = new Map<string, AgentRegistration>();
  const knownAgents = new Map<string, PaseoAgent>();
  const commandCleanups: PluginCleanup[] = [];
  let disposed = false;
  let workspaceReady = false;
  let agentsReady = false;
  const agentUpdatesDuringLoad = new Map<string, PaseoAgent | null>();
  let workspaceSnapshot: WorkspaceDirectorySnapshot = {
    entries: [],
    emptyProjects: [],
    subscriptionId: null,
  };
  let pendingWorkspaceUpdates: WorkspaceDirectoryUpdate[] = [];

  function removeWorkspace(workspaceId: string): void {
    const current = workspaceRegistrations.get(workspaceId);
    if (!current) return;
    current.ref.current = null;
    current.registration.remove();
    workspaceRegistrations.delete(workspaceId);
  }

  function registerWorkspace(workspace: WorkspaceDirectoryEntry): void {
    if (disposed) return;
    if (!visibility.getSnapshot().showHeaderShortcut) {
      removeWorkspace(workspace.id);
      return;
    }
    const existing = workspaceRegistrations.get(workspace.id);
    if (existing && existing.projectId === workspace.projectId) return;
    if (existing) removeWorkspace(workspace.id);

    const ref: RegistrationRef = { current: null };
    const registration = client.addHeaderButton({
      id: "open-scratchpad",
      workspaceId: workspace.id,
      button: {
        title: "Prompt Scratchpad",
        icon: pendingCountIcon(client, workspace.projectId, "Scratchpad", ref),
        label: "Scratchpad",
        behavior: {
          kind: "action",
          onPress: () => client.openPanel("prompt-scratchpad-workspace", {
            workspaceId: workspace.id,
            location: "workspace",
          }),
        },
      },
    });
    ref.current = registration;
    workspaceRegistrations.set(workspace.id, {
      projectId: workspace.projectId,
      registration,
      ref,
    });
  }

  function syncWorkspaces(entries: readonly WorkspaceDirectoryEntry[]): void {
    const activeIds = new Set(entries.map((entry) => entry.id));
    for (const entry of entries) registerWorkspace(entry);
    for (const workspaceId of workspaceRegistrations.keys()) {
      if (!activeIds.has(workspaceId)) removeWorkspace(workspaceId);
    }
  }

  function removeAgent(agentId: string): void {
    const current = agentRegistrations.get(agentId);
    if (!current) return;
    current.registration.remove();
    agentRegistrations.delete(agentId);
  }

  function registerAgent(agent: PaseoAgent): void {
    if (disposed || !activeAgent(agent) || !visibility.getSnapshot().showComposerShortcut) {
      if (agent.id) removeAgent(agent.id);
      return;
    }
    const existing = agentRegistrations.get(agent.id);
    if (existing && existing.workspaceId === agent.workspaceId) return;
    if (existing) removeAgent(agent.id);
    const registration = client.addComposerPill({
      id: "open-scratchpad",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "Prompt Scratchpad",
        icon: "FileText",
        label: "Scratchpad",
        behavior: {
          kind: "action",
          onPress: () => client.openPanel("prompt-scratchpad-agent", {
            workspaceId: agent.workspaceId,
            agentId: agent.id,
            location: "workspace",
          }),
        },
      },
    });
    agentRegistrations.set(agent.id, { workspaceId: agent.workspaceId, registration });
  }

  async function loadWorkspaces(): Promise<void> {
    try {
      const loaded = await fetchWorkspaceDirectory(
        (options) => client.paseo.workspaces.list(options),
      );
      if (disposed) return;
      workspaceSnapshot = pendingWorkspaceUpdates.reduce(applyWorkspaceDirectoryUpdate, loaded);
    } catch (error) {
      if (!disposed) console.warn("Prompt Studio workspace action registration failed", error);
    } finally {
      if (disposed) return;
      workspaceReady = true;
      pendingWorkspaceUpdates = [];
      syncWorkspaces(workspaceSnapshot.entries);
    }
  }

  async function loadAgents(): Promise<void> {
    const agents = new Map<string, PaseoAgent>();
    try {
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < MAX_AGENT_PAGES; pageIndex += 1) {
        const page = await client.paseo.agents.list({
          filter: { includeArchived: false },
          sort: [{ key: "updated_at", direction: "desc" }],
          page: { limit: AGENT_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
        });
        for (const entry of page.entries) agents.set(entry.agent.id, entry.agent);
        if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) break;
        cursor = page.pageInfo.nextCursor;
      }
      if (disposed) return;
      for (const [id, agent] of agentUpdatesDuringLoad) {
        if (agent) agents.set(id, agent);
        else agents.delete(id);
      }
      for (const agent of agents.values()) {
        knownAgents.set(agent.id, agent);
        registerAgent(agent);
      }
    } catch (error) {
      if (!disposed) console.warn("Prompt Studio agent action registration failed", error);
    } finally {
      agentsReady = true;
      agentUpdatesDuringLoad.clear();
    }
  }

  let unsubscribeWorkspaces = () => {};
  let unsubscribeAgents = () => {};
  try {
    unsubscribeWorkspaces = client.paseo.workspaces.subscribe((value) => {
      const update = normalizeWorkspaceDirectoryUpdate(value);
      if (!update) return;
      if (!workspaceReady) {
        pendingWorkspaceUpdates.push(update);
        return;
      }
      workspaceSnapshot = applyWorkspaceDirectoryUpdate(workspaceSnapshot, update);
      syncWorkspaces(workspaceSnapshot.entries);
    });
    unsubscribeAgents = client.paseo.agents.subscribe((update) => {
      if (!agentsReady) {
        if (update.kind === "upsert") agentUpdatesDuringLoad.set(update.agent.id, update.agent);
        else agentUpdatesDuringLoad.set(update.agentId, null);
      }
      if (update.kind === "upsert") {
        knownAgents.set(update.agent.id, update.agent);
        registerAgent(update.agent);
      } else {
        knownAgents.delete(update.agentId);
        removeAgent(update.agentId);
      }
    });
  } catch (error) {
    console.warn("Prompt Studio action subscriptions are unavailable", error);
  }

  commandCleanups.push(
    client.addSlashCommand({
      name: "studio",
      description: "Open Prompt Studio, or save text as a new Project draft",
      argumentHint: "[draft text]",
      context: "workspace",
      async onSubmit({ args, workspace, rpc, openSurface }) {
        if (args.length === 0) {
          openSurface("prompt-studio");
          return;
        }
        await rpc(draftCreateRpc, {
          target: { kind: "project", projectId: workspace.projectId },
          title: "Untitled",
          markdown: args,
        });
        openSurface("prompt-studio");
      },
    }),
    client.addSlashCommand({
      name: "draft",
      description: "Open Prompt Studio drafts, or save text as a new Project draft",
      argumentHint: "[draft text]",
      context: "workspace",
      async onSubmit({ args, workspace, rpc, openSurface }) {
        if (args.length === 0) {
          openSurface("prompt-studio");
          return;
        }
        await rpc(draftCreateRpc, {
          target: { kind: "project", projectId: workspace.projectId },
          title: "Untitled",
          markdown: args,
        });
        openSurface("prompt-studio");
      },
    }),
  );

  void loadWorkspaces();
  void loadAgents();
  const unsubscribeVisibility = visibility.subscribe(() => {
    if (disposed) return;
    syncWorkspaces(workspaceSnapshot.entries);
    for (const agent of knownAgents.values()) registerAgent(agent);
  });

  return async () => {
    if (disposed) return;
    disposed = true;
    unsubscribeVisibility();
    unsubscribeWorkspaces();
    unsubscribeAgents();
    await Promise.all(commandCleanups.map((cleanup) => cleanup()));
    commandCleanups.length = 0;
    for (const workspaceId of [...workspaceRegistrations.keys()]) removeWorkspace(workspaceId);
    for (const agentId of [...agentRegistrations.keys()]) removeAgent(agentId);
    pendingWorkspaceUpdates = [];
    agentUpdatesDuringLoad.clear();
    knownAgents.clear();
  };
}
