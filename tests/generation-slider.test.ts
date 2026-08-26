import assert from "node:assert/strict";
import test from "node:test";
import { sliderIndexAtLocation } from "../src/client/studio/generation-slider.client";

test("slider pointer positions map to the nearest visual stop", () => {
  const width = 400;
  const centers = [50, 150, 250, 350];
  assert.deepEqual(
    centers.map((locationX) => sliderIndexAtLocation(locationX, width, centers.length)),
    [0, 1, 2, 3],
  );
  assert.equal(sliderIndexAtLocation(99, width, centers.length), 0);
  assert.equal(sliderIndexAtLocation(101, width, centers.length), 1);
  assert.equal(sliderIndexAtLocation(299, width, centers.length), 2);
  assert.equal(sliderIndexAtLocation(301, width, centers.length), 3);
});

test("slider geometry clamps edges and degenerate tracks", () => {
  assert.equal(sliderIndexAtLocation(-100, 400, 4), 0);
  assert.equal(sliderIndexAtLocation(500, 400, 4), 3);
  assert.equal(sliderIndexAtLocation(10, 0, 4), 0);
  assert.equal(sliderIndexAtLocation(10, 100, 1), 0);
  assert.equal(sliderIndexAtLocation(10, 100, 0), 0);
});
