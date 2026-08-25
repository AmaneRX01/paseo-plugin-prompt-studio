import assert from "node:assert/strict";
import test from "node:test";
import {
  canTransitionDraftStatus,
  draftStatuses,
  isSendableDraftStatus,
} from "../src/shared/draft-lifecycle.shared";

test("draft lifecycle contains no draft-level star state", () => {
  assert.deepEqual(draftStatuses, ["draft", "ready", "archived"]);
  assert.equal(isSendableDraftStatus("draft"), false);
  assert.equal(isSendableDraftStatus("ready"), true);
  assert.equal(isSendableDraftStatus("archived"), false);
});

test("draft and ready transition directly while archive restores its source state", () => {
  assert.equal(canTransitionDraftStatus("draft", "ready", null), true);
  assert.equal(canTransitionDraftStatus("ready", "draft", null), true);
  assert.equal(canTransitionDraftStatus("draft", "archived", null), true);
  assert.equal(canTransitionDraftStatus("ready", "archived", null), true);
  assert.equal(canTransitionDraftStatus("archived", "ready", "ready"), true);
  assert.equal(canTransitionDraftStatus("archived", "draft", "ready"), false);
});
