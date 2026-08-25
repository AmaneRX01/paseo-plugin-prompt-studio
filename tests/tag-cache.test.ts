import assert from "node:assert/strict";
import test from "node:test";
import { resolveTagSetResponse } from "../src/client/studio/tag-cache.client";

test("a canonical refresh wins over a delayed single-draft tag response", () => {
  assert.deepEqual(resolveTagSetResponse({
    previous: ["A"],
    requested: ["A", "B"],
    response: ["A", "B"],
    cached: ["Renamed"],
    canonical: [],
  }), []);
});

test("an advanced cache is preserved when canonical refresh fails", () => {
  assert.deepEqual(resolveTagSetResponse({
    previous: ["A"],
    requested: ["A", "B"],
    response: ["A", "B"],
    cached: ["Renamed"],
    canonical: null,
  }), ["Renamed"]);
});

test("the successful response is the fallback when the cache has not advanced", () => {
  assert.deepEqual(resolveTagSetResponse({
    previous: ["A"],
    requested: ["A", "B"],
    response: ["A", "B"],
    cached: ["a"],
    canonical: null,
  }), ["A", "B"]);
});
