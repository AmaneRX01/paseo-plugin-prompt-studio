export interface WorkspaceDirectoryEntry {
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  name: string;
  activityAt: string | null;
}

export interface WorkspaceDirectoryProject {
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
}

export interface WorkspaceDirectorySnapshot {
  entries: WorkspaceDirectoryEntry[];
  emptyProjects: WorkspaceDirectoryProject[];
  subscriptionId: string | null;
}

export type WorkspaceDirectoryUpdate =
  | { kind: "upsert"; workspace: WorkspaceDirectoryEntry }
  | {
      kind: "remove";
      id: string;
      emptyProject?: WorkspaceDirectoryProject;
      removedProjectId?: string;
    };

interface WorkspaceDirectoryPageInfo {
  hasMore: boolean;
  nextCursor: string | null;
}

export interface WorkspaceDirectoryListOptions {
  sort: Array<{ key: "activity_at"; direction: "desc" }>;
  page: { limit: number; cursor?: string };
  subscribe?: { subscriptionId?: string };
}

const PAGE_LIMIT = 200;
const MAX_PAGES = 20;

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function normalizeWorkspaceDirectoryEntry(value: unknown): WorkspaceDirectoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const id = requiredString(input.id);
  const projectId = requiredString(input.projectId);
  const projectDisplayName = requiredString(input.projectDisplayName);
  const projectRootPath = requiredString(input.projectRootPath);
  const name = requiredString(input.name);
  if (!id || !projectId || !projectDisplayName || !projectRootPath || !name) return null;
  const workspaceDirectory = optionalString(input.workspaceDirectory);
  return {
    id,
    projectId,
    projectDisplayName,
    projectRootPath,
    ...(workspaceDirectory ? { workspaceDirectory } : {}),
    name,
    activityAt: optionalString(input.activityAt),
  };
}

export function normalizeWorkspaceDirectoryProject(value: unknown): WorkspaceDirectoryProject | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const projectId = requiredString(input.projectId);
  const projectDisplayName = requiredString(input.projectDisplayName);
  const projectRootPath = requiredString(input.projectRootPath);
  return projectId && projectDisplayName && projectRootPath
    ? { projectId, projectDisplayName, projectRootPath }
    : null;
}

export function normalizeWorkspaceDirectoryUpdate(value: unknown): WorkspaceDirectoryUpdate | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.kind === "upsert") {
    const workspace = normalizeWorkspaceDirectoryEntry(input.workspace);
    return workspace ? { kind: "upsert", workspace } : null;
  }
  if (input.kind !== "remove") return null;
  const id = requiredString(input.id);
  if (!id) return null;
  const emptyProject = normalizeWorkspaceDirectoryProject(input.emptyProject);
  const removedProjectId = requiredString(input.removedProjectId);
  return {
    kind: "remove",
    id,
    ...(emptyProject ? { emptyProject } : {}),
    ...(removedProjectId ? { removedProjectId } : {}),
  };
}

function compareWorkspaceActivity(left: WorkspaceDirectoryEntry, right: WorkspaceDirectoryEntry): number {
  return (right.activityAt ?? "").localeCompare(left.activityAt ?? "") || left.id.localeCompare(right.id);
}

export function applyWorkspaceDirectoryUpdate(
  snapshot: WorkspaceDirectorySnapshot,
  update: WorkspaceDirectoryUpdate,
): WorkspaceDirectorySnapshot {
  if (update.kind === "upsert") {
    const current = snapshot.entries.find((entry) => entry.id === update.workspace.id);
    if (current === update.workspace) return snapshot;
    const entries = snapshot.entries
      .filter((entry) => entry.id !== update.workspace.id)
      .concat(update.workspace)
      .sort(compareWorkspaceActivity);
    return {
      ...snapshot,
      entries,
      emptyProjects: snapshot.emptyProjects.filter(
        (project) => project.projectId !== update.workspace.projectId,
      ),
    };
  }

  const entries = snapshot.entries.filter((entry) => entry.id !== update.id);
  let emptyProjects = snapshot.emptyProjects;
  if (update.removedProjectId) {
    emptyProjects = emptyProjects.filter((project) => project.projectId !== update.removedProjectId);
  } else if (update.emptyProject) {
    emptyProjects = emptyProjects
      .filter((project) => project.projectId !== update.emptyProject?.projectId)
      .concat(update.emptyProject);
  }
  if (entries.length === snapshot.entries.length && emptyProjects === snapshot.emptyProjects) return snapshot;
  return { ...snapshot, entries, emptyProjects };
}

function normalizePage(value: unknown): {
  entries: WorkspaceDirectoryEntry[];
  emptyProjects: WorkspaceDirectoryProject[];
  subscriptionId: string | null;
  pageInfo: WorkspaceDirectoryPageInfo;
} {
  if (!value || typeof value !== "object") throw new Error("Paseo returned an invalid Workspace directory page");
  const input = value as Record<string, unknown>;
  const pageInfoInput = input.pageInfo;
  if (!pageInfoInput || typeof pageInfoInput !== "object") {
    throw new Error("Paseo Workspace directory page did not include pagination state");
  }
  const pageInfoRecord = pageInfoInput as Record<string, unknown>;
  const entries = Array.isArray(input.entries)
    ? input.entries.map(normalizeWorkspaceDirectoryEntry).filter((entry): entry is WorkspaceDirectoryEntry => Boolean(entry))
    : [];
  const emptyProjects = Array.isArray(input.emptyProjects)
    ? input.emptyProjects
      .map(normalizeWorkspaceDirectoryProject)
      .filter((project): project is WorkspaceDirectoryProject => Boolean(project))
    : [];
  return {
    entries,
    emptyProjects,
    subscriptionId: optionalString(input.subscriptionId),
    pageInfo: {
      hasMore: pageInfoRecord.hasMore === true,
      nextCursor: optionalString(pageInfoRecord.nextCursor),
    },
  };
}

export async function fetchWorkspaceDirectory(
  list: (options: WorkspaceDirectoryListOptions) => Promise<unknown>,
  subscriptionId?: string | null,
): Promise<WorkspaceDirectorySnapshot> {
  const entries = new Map<string, WorkspaceDirectoryEntry>();
  const emptyProjects = new Map<string, WorkspaceDirectoryProject>();
  let cursor: string | undefined;
  let activeSubscriptionId = subscriptionId ?? null;

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const page = normalizePage(await list({
      sort: [{ key: "activity_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      ...(pageIndex === 0
        ? { subscribe: activeSubscriptionId ? { subscriptionId: activeSubscriptionId } : {} }
        : {}),
    }));
    activeSubscriptionId = page.subscriptionId ?? activeSubscriptionId;
    for (const entry of page.entries) entries.set(entry.id, entry);
    for (const project of page.emptyProjects) emptyProjects.set(project.projectId, project);
    if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) {
      for (const entry of entries.values()) emptyProjects.delete(entry.projectId);
      return {
        entries: [...entries.values()].sort(compareWorkspaceActivity),
        emptyProjects: [...emptyProjects.values()],
        subscriptionId: activeSubscriptionId,
      };
    }
    cursor = page.pageInfo.nextCursor;
  }

  throw new Error(`Paseo Workspace directory exceeded the ${PAGE_LIMIT * MAX_PAGES} item safety limit`);
}
