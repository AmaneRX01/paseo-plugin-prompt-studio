import assert from "node:assert/strict";
import test from "node:test";
import {
  createScopeChangeQueue,
  type ScopeProjectId,
} from "../src/client/studio/scope-change-queue.client";

function manualScheduler() {
  let nextHandle = 1;
  const tasks = new Map<number, () => void>();
  return {
    scheduler: {
      schedule(callback: () => void, _delayMs: number): unknown {
        const handle = nextHandle;
        nextHandle += 1;
        tasks.set(handle, callback);
        return handle;
      },
      cancel(handle: unknown): void {
        tasks.delete(handle as number);
      },
    },
    flush(): void {
      for (const [handle, task] of [...tasks]) {
        tasks.delete(handle);
        task();
      }
    },
  };
}

test("a quick Scope round trip is cancelled before any server commit", () => {
  const clock = manualScheduler();
  const queue = createScopeChangeQueue(1_000, clock.scheduler);
  const committed: ScopeProjectId[] = [];

  assert.equal(queue.select("prj_a", "prj_b", (projectId) => committed.push(projectId)), "queued");
  assert.equal(queue.select("prj_a", "prj_a", (projectId) => committed.push(projectId)), "cancelled");
  clock.flush();

  assert.deepEqual(committed, []);
});

test("rapid Scope choices commit only the final settled target", () => {
  const clock = manualScheduler();
  const queue = createScopeChangeQueue(1_000, clock.scheduler);
  const committed: ScopeProjectId[] = [];

  queue.select("prj_a", "prj_b", (projectId) => committed.push(projectId));
  queue.select("prj_a", null, (projectId) => committed.push(projectId));
  queue.select("prj_a", "prj_c", (projectId) => committed.push(projectId));
  clock.flush();

  assert.deepEqual(committed, ["prj_c"]);
});

test("disposing a pending Scope choice prevents a late commit", () => {
  const clock = manualScheduler();
  const queue = createScopeChangeQueue(1_000, clock.scheduler);
  const committed: ScopeProjectId[] = [];

  assert.equal(queue.select(null, "prj_b", (projectId) => committed.push(projectId)), "queued");
  queue.cancel();
  clock.flush();
  assert.equal(queue.select(null, null, (projectId) => committed.push(projectId)), "unchanged");

  assert.deepEqual(committed, []);
});
