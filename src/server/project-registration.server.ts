import type { ContainerSummary } from "../shared/contracts.shared";
import {
  PromptStudioStore,
  type EnsureContainerResult,
  type ResolvedSourceProject,
} from "./store.server";
import { normalizePath } from "./storage/filesystem.server";

export interface PaseoWorkspaceSnapshot {
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
  workspaceDirectory?: string;
}

export interface PaseoWorkspaceHandleLike {
  id: string;
  projectId: string | null;
  refresh(options?: { requestId?: string }): Promise<PaseoWorkspaceSnapshot | null>;
}

export interface PaseoWorkspaceRegistrar {
  workspaces: {
    ref(workspaceId: string): PaseoWorkspaceHandleLike;
    open(path: string): Promise<PaseoWorkspaceHandleLike>;
    list?(options: {
      filter: { projectId: string };
      sort: Array<{ key: "activity_at"; direction: "desc" }>;
      page: { limit: number; cursor?: string };
    }): Promise<{
      entries: Array<{
        id: string;
        projectId: string;
        projectDisplayName?: string;
        projectRootPath?: string;
      }>;
      emptyProjects?: Array<{
        projectId: string;
        projectDisplayName: string;
        projectRootPath: string;
      }>;
      pageInfo: { nextCursor: string | null; hasMore: boolean };
    }>;
  };
}

export interface EnsureAndRegisterResult {
  created: boolean;
  container: ContainerSummary;
  registrationWarning: string | null;
}

async function resolveWorkspaceProject(
  paseo: PaseoWorkspaceRegistrar,
  projectId: string,
  workspaceId: string,
): Promise<ResolvedSourceProject> {
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace) throw new Error(`Paseo workspace is unavailable: ${workspaceId}`);
  if (workspace.id !== workspaceId) throw new Error(`Paseo returned the wrong workspace for ${workspaceId}`);
  if (workspace.projectId !== projectId) {
    throw new Error(`Workspace ${workspaceId} belongs to project ${workspace.projectId}, not ${projectId}`);
  }
  if (!workspace.projectRootPath || !workspace.projectDisplayName) {
    throw new Error(`Workspace ${workspaceId} did not provide a project root and display name`);
  }
  return {
    projectId,
    rootPath: workspace.projectRootPath,
    name: workspace.projectDisplayName,
  };
}

export async function resolveAvailableSourceProject(
  paseo: PaseoWorkspaceRegistrar,
  projectId: string,
): Promise<ResolvedSourceProject> {
  if (!paseo.workspaces.list) {
    throw new Error(`Paseo Project directory is unavailable for ${projectId}`);
  }

  let cursor: string | undefined;
  let resolved: ResolvedSourceProject | null = null;
  const observe = (candidate: ResolvedSourceProject) => {
    if (!resolved) {
      resolved = candidate;
      return;
    }
    if (normalizePath(resolved.rootPath) !== normalizePath(candidate.rootPath)) {
      throw new Error(`Paseo Project ${projectId} was reported with conflicting roots`);
    }
  };

  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await paseo.workspaces.list({
      filter: { projectId },
      sort: [{ key: "activity_at", direction: "desc" }],
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const project of page.emptyProjects ?? []) {
      if (project.projectId !== projectId) continue;
      observe({
        projectId,
        rootPath: project.projectRootPath,
        name: project.projectDisplayName,
      });
    }
    for (const candidate of page.entries) {
      if (candidate.projectId !== projectId) continue;
      if (candidate.projectRootPath && candidate.projectDisplayName) {
        observe({
          projectId,
          rootPath: candidate.projectRootPath,
          name: candidate.projectDisplayName,
        });
        continue;
      }
      try {
        observe(await resolveWorkspaceProject(paseo, projectId, candidate.id));
      } catch {
        // Continue through this Project's remaining descriptors and Workspaces.
      }
    }
    if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) {
      if (resolved) return resolved;
      throw new Error(`Paseo Project is unavailable: ${projectId}`);
    }
    cursor = page.pageInfo.nextCursor;
  }
  throw new Error(`Paseo Project directory exceeded the pagination safety limit while resolving ${projectId}`);
}

async function registerContainer(
  store: PromptStudioStore,
  paseo: PaseoWorkspaceRegistrar,
  ensured: EnsureContainerResult,
): Promise<EnsureAndRegisterResult> {
  if (ensured.summary.registration.status === "registered") {
    try {
      const current = await paseo.workspaces.ref(ensured.summary.registration.workspaceId).refresh();
      if (
        current
        && current.projectId === ensured.summary.registration.projectId
        && normalizePath(current.projectRootPath) === normalizePath(ensured.placement.companion.rootPath)
      ) {
        return { created: ensured.created, container: ensured.summary, registrationWarning: null };
      }
    } catch {
      // workspaces.open below is idempotent for an existing Project path and also
      // recreates the one managed Project after its Paseo link was removed.
    }
  }
  try {
    const opened = await paseo.workspaces.open(ensured.placement.companion.rootPath);
    const refreshed = await opened.refresh();
    const projectId = opened.projectId ?? refreshed?.projectId ?? null;
    const workspaceId = opened.id || refreshed?.id || null;
    if (!projectId || !workspaceId) {
      throw new Error("Paseo opened the plaintext directory without returning Project/Workspace IDs");
    }
    const container = await store.recordRegistration(ensured.manifest.id, {
      status: "registered",
      projectId,
      workspaceId,
    });
    return { created: ensured.created, container, registrationWarning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const container = await store.recordRegistration(ensured.manifest.id, {
      status: "pending",
      error: message,
    });
    return {
      created: ensured.created,
      container,
      registrationWarning: `The Prompt Studio vault exists, but its single Paseo Project/Workspace registration is pending: ${message}`,
    };
  }
}

export async function ensureAndRegisterInbox(
  store: PromptStudioStore,
  paseo: PaseoWorkspaceRegistrar,
): Promise<EnsureAndRegisterResult> {
  return registerContainer(store, paseo, await store.ensureContainer(null));
}

export async function ensureAndRegisterProjectContainer(
  store: PromptStudioStore,
  paseo: PaseoWorkspaceRegistrar,
  projectId: string,
): Promise<EnsureAndRegisterResult> {
  const source = await resolveAvailableSourceProject(paseo, projectId);
  const managedSelf = await store.findContainerByRoot(source.rootPath);
  if (managedSelf) {
    return registerContainer(store, paseo, await store.ensureContainer(null));
  }
  if (await store.isManagedPath(source.rootPath)) {
    throw new Error("A Prompt Studio vault or legacy vault subdirectory cannot be linked as an external Project");
  }
  return registerContainer(store, paseo, await store.ensureContainer(source));
}
