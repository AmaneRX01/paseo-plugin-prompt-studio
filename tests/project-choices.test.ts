import assert from "node:assert/strict";
import test from "node:test";
import {
  isPathInsideVault,
  projectChoicesFromWorkspaces,
} from "../src/client/studio/project-choices.client";

test("Scope collapses Agent-task Workspaces into one choice per Project", () => {
  const choices = projectChoicesFromWorkspaces([
    { id: "wks_review", projectId: "prj_worklog", projectDisplayName: "worklog_plugin" },
    { id: "wks_scratchpad", projectId: "prj_worklog", projectDisplayName: "worklog_plugin" },
    { id: "wks_dialogic", projectId: "prj_game", projectDisplayName: "game" },
  ]);

  assert.deepEqual(choices, [
    {
      projectId: "prj_worklog",
      projectDisplayName: "worklog_plugin",
      workspaceLocatorId: "wks_review",
    },
    {
      projectId: "prj_game",
      projectDisplayName: "game",
      workspaceLocatorId: "wks_dialogic",
    },
  ]);
  assert.equal(choices.some((choice) => "name" in choice), false);
});

test("vault and legacy vault Workspace paths are excluded without matching sibling prefixes", () => {
  assert.equal(
    isPathInsideVault("C:\\Users\\me\\.paseo\\prompt-studio", "c:/users/me/.paseo/prompt-studio"),
    true,
  );
  assert.equal(
    isPathInsideVault(
      "C:\\Users\\me\\.paseo\\prompt-studio",
      "C:\\Users\\me\\.paseo\\prompt-studio\\legacy\\containers\\ct_inbox",
    ),
    true,
  );
  assert.equal(
    isPathInsideVault(
      "C:\\Users\\me\\.paseo\\prompt-studio",
      "C:\\Users\\me\\.paseo\\prompt-studio-copy",
    ),
    false,
  );
  assert.equal(isPathInsideVault("/Users/me/Vault", "/Users/me/Vault/legacy"), true);
  assert.equal(isPathInsideVault("/Users/me/Vault", "/Users/me/vault/legacy"), false);
});
