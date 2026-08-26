import assert from "node:assert/strict";
import test from "node:test";
import { KeyedLockQueue } from "../src/server/storage/locking.server";

test("keyed lock queue serializes one key and releases after failure", async () => {
  const queue = new KeyedLockQueue();
  const order: string[] = [];
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const first = queue.run(
    "draft",
    async () => async () => {
      order.push("release-1");
    },
    async () => {
      order.push("start-1");
      await blocked;
      throw new Error("expected");
    },
  );
  const second = queue.run(
    "draft",
    async () => async () => {
      order.push("release-2");
    },
    async () => {
      order.push("start-2");
      return "done";
    },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start-1"]);
  unblock();
  await assert.rejects(first, /expected/);
  assert.equal(await second, "done");
  assert.deepEqual(order, ["start-1", "release-1", "start-2", "release-2"]);
});

test("a failed durable release does not strand the in-process queue", async () => {
  const queue = new KeyedLockQueue();
  await assert.rejects(
    queue.run(
      "draft",
      async () => async () => {
        throw new Error("release failed");
      },
      async () => "first",
    ),
    /release failed/,
  );
  assert.equal(
    await queue.run("draft", async () => async () => {}, async () => "second"),
    "second",
  );
});
