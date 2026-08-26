import assert from "node:assert/strict";
import test from "node:test";
import type { DraftSummary } from "../src/shared/contracts.shared";
import { planBatchDraftTransitions } from "../src/client/studio/batch-selection.client";

function summary(
  id: string,
  status: DraftSummary["status"],
  archivedFromStatus: DraftSummary["archivedFromStatus"] = null,
): DraftSummary {
  return {
    schemaVersion: 5,
    id,
    containerId: "ct_inbox",
    title: id,
    status,
    tags: [],
    scope: { projectId: null, projectName: null },
    version: 3,
    contentHash: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    archivedAt: status === "archived" ? "2026-08-27T01:00:00.000Z" : null,
    archivedFromStatus,
    lastCheckpointAt: null,
    snapshotCount: 0,
    dispatchCount: 0,
    contentOrigin: { kind: "manual" },
    preview: "",
  };
}

const draft = summary("dr_1111111111111111", "draft");
const ready = summary("dr_2222222222222222", "ready");
const archivedDraft = summary("dr_3333333333333333", "archived", "draft");
const archivedReady = summary("dr_4444444444444444", "archived", "ready");
const selected = [draft, ready, archivedDraft, archivedReady];

test("batch lifecycle planning applies each action only to eligible selected drafts", () => {
  assert.deepEqual(
    planBatchDraftTransitions(selected, "set-ready").map((item) => [item.draftId, item.targetStatus]),
    [[draft.id, "ready"]],
  );
  assert.deepEqual(
    planBatchDraftTransitions(selected, "set-draft").map((item) => [item.draftId, item.targetStatus]),
    [[ready.id, "draft"]],
  );
  assert.deepEqual(
    planBatchDraftTransitions(selected, "archive").map((item) => [item.draftId, item.targetStatus]),
    [[draft.id, "archived"], [ready.id, "archived"]],
  );
});

test("batch restore preserves each archived draft's pre-archive state", () => {
  assert.deepEqual(
    planBatchDraftTransitions(selected, "restore").map((item) => [item.draftId, item.targetStatus]),
    [[archivedDraft.id, "draft"], [archivedReady.id, "ready"]],
  );
});

test("planned transitions retain optimistic version and hash checks", () => {
  assert.deepEqual(planBatchDraftTransitions([draft], "set-ready"), [{
    draftId: draft.id,
    targetStatus: "ready",
    expectedVersion: draft.version,
    expectedHash: draft.contentHash,
  }]);
});
