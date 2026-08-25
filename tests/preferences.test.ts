import assert from "node:assert/strict";
import test from "node:test";
import {
  getShowDescriptions,
  setShowDescriptions,
  translate,
} from "../src/client/i18n.client";
import {
  getHistoryPreferences,
  setCheckpointLimit,
  setSnapshotLimit,
  setStarredCheckpointsCountTowardLimit,
  toggleCheckpointStar,
} from "../src/client/studio/history-preferences.client";

test("description visibility is shared and reversible", () => {
  const initial = getShowDescriptions();
  try {
    setShowDescriptions(false);
    assert.equal(getShowDescriptions(), false);
    setShowDescriptions(true);
    assert.equal(getShowDescriptions(), true);
  } finally {
    setShowDescriptions(initial);
  }
});

test("settings copy is available in both languages", () => {
  assert.equal(translate("en", "settings.open"), "Settings");
  assert.equal(translate("zh", "settings.open"), "设置");
  assert.equal(translate("en", "settings.descriptions.label"), "Show descriptions");
  assert.equal(translate("zh", "settings.descriptions.label"), "显示说明文字");
  assert.equal(translate("en", "settings.history.snapshots"), "Recent snapshots");
  assert.equal(translate("zh", "settings.history.checkpoints"), "最近检查点");
});

test("history preferences and checkpoint stars are shared and reversible", () => {
  const initial = getHistoryPreferences();
  const draftId = "dr_1111111111111111";
  const checkpointId = "cp_111111111111111111111111";
  const initiallyStarred = initial.checkpointStarsByDraft[draftId]?.includes(checkpointId) ?? false;
  try {
    setSnapshotLimit(10);
    setCheckpointLimit(20);
    setStarredCheckpointsCountTowardLimit(false);
    if (initiallyStarred) toggleCheckpointStar(draftId, checkpointId);
    toggleCheckpointStar(draftId, checkpointId);
    const updated = getHistoryPreferences();
    assert.equal(updated.snapshotLimit, 10);
    assert.equal(updated.checkpointLimit, 20);
    assert.equal(updated.starredCheckpointsCountTowardLimit, false);
    assert.equal(updated.checkpointStarsByDraft[draftId]?.includes(checkpointId), true);
  } finally {
    setSnapshotLimit(initial.snapshotLimit);
    setCheckpointLimit(initial.checkpointLimit);
    setStarredCheckpointsCountTowardLimit(initial.starredCheckpointsCountTowardLimit);
    const currentlyStarred = getHistoryPreferences().checkpointStarsByDraft[draftId]?.includes(checkpointId) ?? false;
    if (currentlyStarred !== initiallyStarred) toggleCheckpointStar(draftId, checkpointId);
  }
});
