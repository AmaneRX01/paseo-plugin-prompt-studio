import assert from "node:assert/strict";
import test from "node:test";
import { groupWorkspacesByProject } from "../src/client/studio/workspace-groups.client";

test("send targets are grouped by Project without flattening Workspaces", () => {
  const groups = groupWorkspacesByProject([
    { id: "ws_a_recent", name: "Review", projectId: "project_a", projectDisplayName: "Alpha" },
    { id: "ws_b", name: "Main", projectId: "project_b", projectDisplayName: "Beta" },
    { id: "ws_a_old", name: "Scratch", projectId: "project_a", projectDisplayName: "Alpha" },
  ]);

  assert.deepEqual(groups, [
    {
      projectId: "project_a",
      projectDisplayName: "Alpha",
      workspaces: [
        { id: "ws_a_recent", name: "Review", projectId: "project_a", projectDisplayName: "Alpha" },
        { id: "ws_a_old", name: "Scratch", projectId: "project_a", projectDisplayName: "Alpha" },
      ],
    },
    {
      projectId: "project_b",
      projectDisplayName: "Beta",
      workspaces: [
        { id: "ws_b", name: "Main", projectId: "project_b", projectDisplayName: "Beta" },
      ],
    },
  ]);
});

test("Projects with the same display name remain distinct", () => {
  const groups = groupWorkspacesByProject([
    { id: "ws_a", name: "Main", projectId: "project_a", projectDisplayName: "Shared" },
    { id: "ws_b", name: "Main", projectId: "project_b", projectDisplayName: "Shared" },
  ]);

  assert.deepEqual(groups.map((group) => group.projectId), ["project_a", "project_b"]);
});

test("the Draft Project is placed first without disturbing other activity order", () => {
  const groups = groupWorkspacesByProject([
    { id: "ws_b", name: "Main", projectId: "project_b", projectDisplayName: "Beta" },
    { id: "ws_c", name: "Main", projectId: "project_c", projectDisplayName: "Gamma" },
    { id: "ws_a_recent", name: "Review", projectId: "project_a", projectDisplayName: "Alpha" },
    { id: "ws_a_old", name: "Scratch", projectId: "project_a", projectDisplayName: "Alpha" },
  ], "project_a");

  assert.deepEqual(groups.map((group) => group.projectId), ["project_a", "project_b", "project_c"]);
  assert.deepEqual(groups[0].workspaces.map((workspace) => workspace.id), ["ws_a_recent", "ws_a_old"]);
});

test("Projects without Workspaces remain visible as empty groups", () => {
  const groups = groupWorkspacesByProject([], null, [{
    projectId: "project_empty",
    projectDisplayName: "Empty",
  }]);

  assert.deepEqual(groups, [{
    projectId: "project_empty",
    projectDisplayName: "Empty",
    workspaces: [],
  }]);
});
