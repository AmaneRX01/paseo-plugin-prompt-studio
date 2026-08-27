import assert from "node:assert/strict";
import test from "node:test";
import { groupWorkspacesByProject } from "../src/client/studio/workspace-groups.client";

function workspace(id: string, name: string, projectId: string, projectDisplayName: string) {
  return { id, name, projectId, projectDisplayName, projectRootPath: `D:\\${projectId}` };
}

test("send targets are grouped by Project without flattening Workspaces", () => {
  const groups = groupWorkspacesByProject([
    workspace("ws_a_recent", "Review", "project_a", "Alpha"),
    workspace("ws_b", "Main", "project_b", "Beta"),
    workspace("ws_a_old", "Scratch", "project_a", "Alpha"),
  ]);

  assert.deepEqual(groups, [
    {
      projectId: "project_a",
      projectDisplayName: "Alpha",
      projectRootPath: "D:\\project_a",
      workspaces: [
        workspace("ws_a_recent", "Review", "project_a", "Alpha"),
        workspace("ws_a_old", "Scratch", "project_a", "Alpha"),
      ],
    },
    {
      projectId: "project_b",
      projectDisplayName: "Beta",
      projectRootPath: "D:\\project_b",
      workspaces: [
        workspace("ws_b", "Main", "project_b", "Beta"),
      ],
    },
  ]);
});

test("Projects with the same display name remain distinct", () => {
  const groups = groupWorkspacesByProject([
    workspace("ws_a", "Main", "project_a", "Shared"),
    workspace("ws_b", "Main", "project_b", "Shared"),
  ]);

  assert.deepEqual(groups.map((group) => group.projectId), ["project_a", "project_b"]);
});

test("the Draft Project is placed first without disturbing other activity order", () => {
  const groups = groupWorkspacesByProject([
    workspace("ws_b", "Main", "project_b", "Beta"),
    workspace("ws_c", "Main", "project_c", "Gamma"),
    workspace("ws_a_recent", "Review", "project_a", "Alpha"),
    workspace("ws_a_old", "Scratch", "project_a", "Alpha"),
  ], "project_a");

  assert.deepEqual(groups.map((group) => group.projectId), ["project_a", "project_b", "project_c"]);
  assert.deepEqual(groups[0].workspaces.map((workspace) => workspace.id), ["ws_a_recent", "ws_a_old"]);
});

test("Projects without Workspaces remain visible as empty groups", () => {
  const groups = groupWorkspacesByProject([], null, [{
    projectId: "project_empty",
    projectDisplayName: "Empty",
    projectRootPath: "D:\\project_empty",
  }]);

  assert.deepEqual(groups, [{
    projectId: "project_empty",
    projectDisplayName: "Empty",
    projectRootPath: "D:\\project_empty",
    workspaces: [],
  }]);
});
