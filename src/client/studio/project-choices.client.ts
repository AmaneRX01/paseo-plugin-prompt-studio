export interface ProjectWorkspaceLocator {
  id: string;
  projectId: string;
  projectDisplayName: string;
}

export interface ProjectChoice {
  projectId: string;
  projectDisplayName: string;
  workspaceLocatorId: string | null;
}

export interface EmptyProjectChoice {
  projectId: string;
  projectDisplayName: string;
}

function comparablePath(value: string, windows: boolean): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return windows ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export function isPathInsideVault(vaultRoot: string, candidatePath: string): boolean {
  const windows = /^[a-z]:[\\/]/i.test(vaultRoot) || vaultRoot.includes("\\");
  const root = comparablePath(vaultRoot, windows);
  const candidate = comparablePath(candidatePath, windows);
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * Paseo commonly creates a fresh Workspace for an Agent task. Scope is Project
 * based, so all of those task Workspaces must collapse into one visible choice.
 * The first (most recently active) Workspace remains only as a server locator.
 */
export function projectChoicesFromWorkspaces(
  workspaces: readonly ProjectWorkspaceLocator[],
  emptyProjects: readonly EmptyProjectChoice[] = [],
): ProjectChoice[] {
  const projects = new Map<string, ProjectChoice>();
  for (const workspace of workspaces) {
    if (projects.has(workspace.projectId)) continue;
    projects.set(workspace.projectId, {
      projectId: workspace.projectId,
      projectDisplayName: workspace.projectDisplayName,
      workspaceLocatorId: workspace.id,
    });
  }
  for (const project of emptyProjects) {
    if (projects.has(project.projectId)) continue;
    projects.set(project.projectId, {
      projectId: project.projectId,
      projectDisplayName: project.projectDisplayName,
      workspaceLocatorId: null,
    });
  }
  return [...projects.values()];
}
