export interface WorkspacePickerChoice {
  id: string;
  name: string;
  projectId: string;
  projectDisplayName: string;
}

export interface ProjectWorkspaceGroup {
  projectId: string;
  projectDisplayName: string;
  workspaces: WorkspacePickerChoice[];
}

export interface WorkspaceDirectoryProjectChoice {
  projectId: string;
  projectDisplayName: string;
}

/**
 * Preserve Paseo's activity ordering while exposing the Project hierarchy that
 * owns each Workspace. The first Workspace for a Project determines the
 * Project's position in the picker.
 */
export function groupWorkspacesByProject(
  workspaces: readonly WorkspacePickerChoice[],
  prioritizedProjectId?: string | null,
  projects: readonly WorkspaceDirectoryProjectChoice[] = [],
): ProjectWorkspaceGroup[] {
  const groups = new Map<string, ProjectWorkspaceGroup>();
  for (const workspace of workspaces) {
    const existing = groups.get(workspace.projectId);
    if (existing) {
      existing.workspaces.push(workspace);
      continue;
    }
    groups.set(workspace.projectId, {
      projectId: workspace.projectId,
      projectDisplayName: workspace.projectDisplayName,
      workspaces: [workspace],
    });
  }
  for (const project of projects) {
    if (groups.has(project.projectId)) continue;
    groups.set(project.projectId, {
      projectId: project.projectId,
      projectDisplayName: project.projectDisplayName,
      workspaces: [],
    });
  }
  const ordered = [...groups.values()];
  if (!prioritizedProjectId) return ordered;
  const prioritizedIndex = ordered.findIndex((group) => group.projectId === prioritizedProjectId);
  if (prioritizedIndex <= 0) return ordered;
  const [prioritized] = ordered.splice(prioritizedIndex, 1);
  return [prioritized, ...ordered];
}
