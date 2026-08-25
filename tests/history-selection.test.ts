import assert from "node:assert/strict";
import test from "node:test";
import type { Checkpoint, Snapshot } from "../src/shared/contracts.shared";
import {
  selectRecentSnapshots,
  selectVisibleCheckpoints,
} from "../src/client/studio/history-preferences.client";

const contentHash = `sha256:${"a".repeat(64)}`;
const draftId = "dr_1111111111111111";

function checkpoint(sequence: number): Checkpoint {
  return {
    id: `cp_${String(sequence).padStart(24, "0")}`,
    draftId,
    reason: "periodic",
    at: `2026-08-${String(sequence).padStart(2, "0")}T00:00:00.000Z`,
    version: sequence,
    contentHash,
  };
}

function snapshot(sequence: number): Snapshot {
  return {
    schemaVersion: 2,
    id: `sn_${String(sequence).padStart(24, "0")}`,
    draftId,
    createdAt: `2026-08-${String(sequence).padStart(2, "0")}T00:00:00.000Z`,
    title: `Snapshot ${sequence}`,
    version: sequence,
    contentHash,
    scope: { projectId: null, projectName: null },
    markdown: `Snapshot ${sequence}`,
  };
}

test("snapshots are limited to the newest entries regardless of input order", () => {
  const selected = selectRecentSnapshots([snapshot(2), snapshot(5), snapshot(1), snapshot(4), snapshot(3)], 3);
  assert.deepEqual(selected.map((value) => value.version), [5, 4, 3]);
});

test("starred checkpoints consume the limit before recent unstarred checkpoints", () => {
  const checkpoints = [1, 2, 3, 4, 5, 6].map(checkpoint);
  const stars = new Set([checkpoint(1).id, checkpoint(3).id]);
  const selected = selectVisibleCheckpoints(checkpoints, stars, 3, true);
  assert.deepEqual(selected.map((value) => value.version), [6, 3, 1]);
});

test("when starred checkpoints exceed the limit, the newest starred entries win in time order", () => {
  const checkpoints = [1, 2, 3, 4, 5, 6].map(checkpoint);
  const stars = new Set([checkpoint(1).id, checkpoint(3).id, checkpoint(5).id, checkpoint(6).id]);
  const selected = selectVisibleCheckpoints(checkpoints, stars, 3, true);
  assert.deepEqual(selected.map((value) => value.version), [6, 5, 3]);
});

test("starred checkpoints sit outside the limit when configured not to count", () => {
  const checkpoints = [1, 2, 3, 4, 5, 6].map(checkpoint);
  const stars = new Set([checkpoint(1).id, checkpoint(3).id]);
  const selected = selectVisibleCheckpoints(checkpoints, stars, 3, false);
  assert.deepEqual(selected.map((value) => value.version), [6, 5, 4, 3, 1]);
});
