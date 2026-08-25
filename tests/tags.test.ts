import assert from "node:assert/strict";
import test from "node:test";
import {
  addTags,
  applyTagBatch,
  buildTagTree,
  filterByTagPaths,
  foldCaseInsensitive,
  normalizeTag,
  normalizeTags,
  parseTagPath,
  removeTags,
  renameTagPath,
  sameTagSet,
  tagKey,
  tagMatchesPath,
  tagsMatchAnyPath,
} from "../src/shared/tags.shared";

test("tag paths use NFC, trim every segment, and discard empty slash segments", () => {
  const decomposed = " Cafe\u0301 /  Child  // Grandchild / ";
  assert.equal(normalizeTag(decomposed), "Café/Child/Grandchild");
  assert.equal(normalizeTag(" /  // "), "");
  assert.deepEqual(parseTagPath(decomposed), {
    path: "Café/Child/Grandchild",
    key: "café/child/grandchild",
    segments: ["Café", "Child", "Grandchild"],
    segmentKeys: ["café", "child", "grandchild"],
  });
});

test("normalization de-duplicates case-insensitively while retaining first display spelling", () => {
  assert.deepEqual(normalizeTags([
    " Work / Frontend ",
    "work/frontend",
    "WORK / FRONTEND",
    "Straße",
    "STRASSE",
    "",
    "///",
    "Another",
  ]), ["Work/Frontend", "Straße", "Another"]);
  assert.equal(tagKey(" work / FRONTEND "), "work/frontend");
  assert.equal(tagKey("///"), "");
  assert.equal(foldCaseInsensitive("Straße CAFÉ"), "strasse café");
});

test("tag-set comparison ignores spelling, order, duplicate paths, and canonical Unicode form", () => {
  assert.equal(sameTagSet(
    ["B", "Cafe\u0301/Child", "b"],
    ["CAFÉ/CHILD", "b"],
  ), true);
  assert.equal(sameTagSet(["A/B"], ["A"]), false);
});

test("path matching is case-insensitive and respects segment boundaries", () => {
  assert.equal(tagMatchesPath("A", "a"), true);
  assert.equal(tagMatchesPath("A/B/C", "a/b"), true);
  assert.equal(tagMatchesPath("A/BC", "a/b"), false);
  assert.equal(tagMatchesPath("A", "A/B"), false);
  assert.equal(tagMatchesPath("A/B", "//"), false);
});

test("selected tag paths use parent-includes-descendants and OR filter semantics", () => {
  const drafts = [
    { id: "one", tags: ["A/B"] },
    { id: "two", tags: ["X/Y"] },
    { id: "three", tags: ["Else"] },
  ];

  assert.equal(tagsMatchAnyPath(["A/B/C"], ["a"]), true);
  assert.equal(tagsMatchAnyPath(["A/B"], ["X", "A/B"]), true);
  assert.equal(tagsMatchAnyPath(["Else"], ["X", "A/B"]), false);
  assert.equal(tagsMatchAnyPath([], []), true);
  assert.equal(tagsMatchAnyPath([], ["A"]), false);
  assert.deepEqual(filterByTagPaths(drafts, ["a", "x/y"]).map(({ id }) => id), ["one", "two"]);
  assert.deepEqual(filterByTagPaths(drafts, []).map(({ id }) => id), ["one", "two", "three"]);
});

test("tag directory reports exact and unique-descendant draft counts", () => {
  const tree = buildTagTree([
    { tags: ["A/B", "A/C", "a/b"] },
    { tags: ["a", "a/b", "X"] },
    { tags: ["A/B/D", "x/Y", "A/B"] },
  ]);

  assert.deepEqual(tree, [
    {
      name: "A",
      path: "A",
      count: 3,
      directCount: 1,
      children: [
        {
          name: "B",
          path: "A/B",
          count: 3,
          directCount: 3,
          children: [
            {
              name: "D",
              path: "A/B/D",
              count: 1,
              directCount: 1,
              children: [],
            },
          ],
        },
        {
          name: "C",
          path: "A/C",
          count: 1,
          directCount: 1,
          children: [],
        },
      ],
    },
    {
      name: "X",
      path: "X",
      count: 2,
      directCount: 1,
      children: [
        {
          name: "Y",
          path: "X/Y",
          count: 1,
          directCount: 1,
          children: [],
        },
      ],
    },
  ]);
});

test("renaming rewrites a whole subtree and merges destination conflicts", () => {
  const original = ["Old", "old/Child", "Target/Child", "OLD/Deep/Leaf", "Else"];
  assert.deepEqual(renameTagPath(original, "OLD", "target"), [
    "target",
    "target/Child",
    "target/Deep/Leaf",
    "Else",
  ]);
  assert.deepEqual(original, ["Old", "old/Child", "Target/Child", "OLD/Deep/Leaf", "Else"]);
});

test("case-only subtree renames adopt the requested spelling", () => {
  assert.deepEqual(renameTagPath(["Area", "AREA/One"], "area", "area"), ["area", "area/One"]);
  assert.deepEqual(renameTagPath(["A", "A/B"], "missing", "X"), ["A", "A/B"]);
  assert.deepEqual(renameTagPath([" A ", "a"], "A", "///"), ["A"]);
});

test("batch add and remove operations are normalized, case-insensitive, and immutable", () => {
  const original = ["A/B", "X", "C", "c/D"];
  assert.deepEqual(addTags(original, ["a/b", " New / Child "]), ["A/B", "X", "C", "c/D", "New/Child"]);
  assert.deepEqual(removeTags(original, ["c"]), ["A/B", "X", "c/D"]);
  assert.deepEqual(removeTags(original, ["a", "C"], { includeDescendants: true }), ["X"]);
  assert.deepEqual(applyTagBatch(original, {
    remove: ["x", "c"],
    add: ["x", "Z"],
    includeDescendants: true,
  }), ["A/B", "x", "Z"]);
  assert.deepEqual(original, ["A/B", "X", "C", "c/D"]);
});
