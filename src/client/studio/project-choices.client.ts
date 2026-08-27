export interface ProjectWorkspaceLocator {
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
}

export interface ProjectChoice {
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string | null;
}

export interface EmptyProjectChoice {
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
}

function comparablePath(value: string, windows: boolean): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return windows ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export function isSamePath(left: string, right: string): boolean {
  const windows = /^[a-z]:[\\/]/i.test(left)
    || /^[a-z]:[\\/]/i.test(right)
    || left.includes("\\")
    || right.includes("\\");
  return comparablePath(left, windows) === comparablePath(right, windows);
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
 * Project identity and root remain selectable even when there is no Workspace.
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
      projectRootPath: workspace.projectRootPath,
    });
  }
  for (const project of emptyProjects) {
    if (projects.has(project.projectId)) continue;
    projects.set(project.projectId, {
      projectId: project.projectId,
      projectDisplayName: project.projectDisplayName,
      projectRootPath: project.projectRootPath,
    });
  }
  return [...projects.values()];
}
