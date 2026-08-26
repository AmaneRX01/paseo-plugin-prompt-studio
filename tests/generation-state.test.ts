import assert from "node:assert/strict";
import test from "node:test";
import {
  generationStatusMessageKey,
  isUnresolvedGenerationStatus,
} from "../src/client/studio/generation-state.client";

test("only durable unfinished generation states lock a draft", () => {
  for (const status of ["prepared", "launching", "running", "result-ready", "conflict", "needs-attention"] as const) {
    assert.equal(isUnresolvedGenerationStatus(status), true, status);
  }
  for (const status of ["applied", "failed", "discarded", "abandoned"] as const) {
    assert.equal(isUnresolvedGenerationStatus(status), false, status);
  }
});

test("every generation state has localized message routing", () => {
  assert.equal(generationStatusMessageKey("prepared"), "generation.phase.prepared");
  assert.equal(generationStatusMessageKey("result-ready"), "generation.phase.result-ready");
  assert.equal(generationStatusMessageKey("needs-attention"), "generation.phase.needs-attention");
  assert.equal(generationStatusMessageKey("conflict"), "generation.phase.conflict");
  assert.equal(generationStatusMessageKey("applied"), "generation.phase.applied");
});
