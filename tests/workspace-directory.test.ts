import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkspaceDirectoryUpdate,
  fetchWorkspaceDirectory,
  normalizeWorkspaceDirectoryUpdate,
  type WorkspaceDirectoryEntry,
  type WorkspaceDirectorySnapshot,
} from "../src/client/studio/workspace-directory-state.client";

function workspace(
  id: string,
  projectId: string,
  activityAt: string,
): WorkspaceDirectoryEntry {
  return {
    id,
    projectId,
    projectDisplayName: projectId,
    projectRootPath: `D:\\${projectId}`,
    name: id,
    activityAt,
  };
}

test("Workspace directory follows every page and retains empty Projects", async () => {
  const requests: Array<{ cursor?: string; subscriptionId?: string }> = [];
  const result = await fetchWorkspaceDirectory(async (options) => {
    requests.push({
      cursor: options.page.cursor,
      subscriptionId: options.subscribe?.subscriptionId,
    });
    if (!options.page.cursor) {
      return {
        entries: [workspace("wks_old", "prj_a", "2026-08-27T01:00:00.000Z")],
        emptyProjects: [{
          projectId: "prj_empty",
          projectDisplayName: "Empty",
          projectRootPath: "D:\\empty",
        }],
        subscriptionId: "sub_workspace_directory",
        pageInfo: { hasMore: true, nextCursor: "page-2" },
      };
    }
    return {
      entries: [workspace("wks_new", "prj_b", "2026-08-27T02:00:00.000Z")],
      emptyProjects: [],
      subscriptionId: null,
      pageInfo: { hasMore: false, nextCursor: null },
    };
  }, "sub_existing");

  assert.deepEqual(requests, [
    { cursor: undefined, subscriptionId: "sub_existing" },
    { cursor: "page-2", subscriptionId: undefined },
  ]);
  assert.deepEqual(result.entries.map((entry) => entry.id), ["wks_new", "wks_old"]);
  assert.deepEqual(result.emptyProjects.map((project) => project.projectId), ["prj_empty"]);
  assert.equal(result.subscriptionId, "sub_workspace_directory");
});

test("Workspace upserts make an empty Project selectable and removals restore its empty state", () => {
  const initial: WorkspaceDirectorySnapshot = {
    entries: [],
    emptyProjects: [{
      projectId: "prj_new",
      projectDisplayName: "New Project",
      projectRootPath: "D:\\new-project",
    }],
    subscriptionId: "sub_1",
  };
  const upsert = normalizeWorkspaceDirectoryUpdate({
    kind: "upsert",
    workspace: workspace("wks_new", "prj_new", "2026-08-27T03:00:00.000Z"),
  });
  assert.ok(upsert);
  const active = applyWorkspaceDirectoryUpdate(initial, upsert);
  assert.deepEqual(active.entries.map((entry) => entry.id), ["wks_new"]);
  assert.deepEqual(active.emptyProjects, []);

  const remove = normalizeWorkspaceDirectoryUpdate({
    kind: "remove",
    id: "wks_new",
    emptyProject: {
      projectId: "prj_new",
      projectDisplayName: "New Project",
      projectRootPath: "D:\\new-project",
    },
  });
  assert.ok(remove);
  const empty = applyWorkspaceDirectoryUpdate(active, remove);
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(empty.emptyProjects.map((project) => project.projectId), ["prj_new"]);
});

test("Project deletion removes its empty Project directory entry", () => {
  const snapshot: WorkspaceDirectorySnapshot = {
    entries: [],
    emptyProjects: [{
      projectId: "prj_deleted",
      projectDisplayName: "Deleted",
      projectRootPath: "D:\\deleted",
    }],
    subscriptionId: null,
  };
  const update = normalizeWorkspaceDirectoryUpdate({
    kind: "remove",
    id: "wks_missing",
    removedProjectId: "prj_deleted",
  });
  assert.ok(update);
  assert.deepEqual(applyWorkspaceDirectoryUpdate(snapshot, update).emptyProjects, []);
});
