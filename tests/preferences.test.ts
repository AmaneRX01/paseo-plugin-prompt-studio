import assert from "node:assert/strict";
import test from "node:test";
import {
  getShowDescriptions,
  setShowDescriptions,
  translate,
} from "../src/client/i18n.client";
import {
  DEFAULT_BOILERPLATES,
  appendBoilerplate,
  getBoilerplates,
  replaceBoilerplates,
} from "../src/client/studio/boilerplate-preferences.client";
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
  assert.equal(translate("en", "settings.generation.related"), "Related-prompt optimization");
  assert.equal(translate("zh", "settings.generation.format"), "行文格式润色");
  assert.equal(translate("en", "generation.time.days", { count: 14 }), "14 days");
  assert.equal(translate("zh", "settings.generation.timeRanges.title"), "参考时间范围");
  assert.equal(translate("en", "generation.related.action"), "Prompt optimization");
  assert.equal(translate("en", "generation.format.action"), "Quick optimization");
  assert.equal(translate("zh", "generation.related.action"), "Prompt 优化");
  assert.equal(translate("zh", "generation.format.action"), "快速优化");
  assert.equal(translate("en", "boilerplate.action"), "Add boilerplate");
  assert.equal(translate("zh", "boilerplate.action"), "添加定型文");
});

test("boilerplates start with three English fragments and remain language-neutral", () => {
  assert.deepEqual(DEFAULT_BOILERPLATES, [
    "Keep the response concise and focused.",
    "Avoid adding fragmented or redundant test work.",
    "Make only changes that are directly related to the request.",
  ]);

  const initial = getBoilerplates();
  try {
    replaceBoilerplates(["Custom phrase", "  Custom phrase  ", "", "另一个片段"]);
    assert.deepEqual(getBoilerplates(), ["Custom phrase", "另一个片段"]);
  } finally {
    replaceBoilerplates(initial);
  }
});

test("boilerplates append to Markdown without rewriting existing content", () => {
  assert.equal(appendBoilerplate("", " Be concise. "), "Be concise.");
  assert.equal(appendBoilerplate("Existing", "Be concise."), "Existing\n\nBe concise.");
  assert.equal(appendBoilerplate("Existing\n", "Be concise."), "Existing\n\nBe concise.");
  assert.equal(appendBoilerplate("Existing\n\n", "Be concise."), "Existing\n\nBe concise.");
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
