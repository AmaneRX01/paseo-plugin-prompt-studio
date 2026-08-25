import assert from "node:assert/strict";
import test from "node:test";
import {
  activeFilterSelection,
  activeNullableFilterSelection,
  isAllSelected,
  normalizeNullableFilterSelection,
  toggleActiveFilterSelection,
  toggleFilterSelection,
  toggleNullableFilterSelection,
} from "../src/client/studio/filter-selection.client";

const statuses = ["draft", "ready", "archived"];

test("multi-select filters default to all options and can clear every option", () => {
  assert.equal(isAllSelected(statuses, statuses), true);
  assert.deepEqual(toggleFilterSelection(statuses, "ready", statuses), ["draft", "archived"]);
  const cleared = statuses.reduce<string[]>(
    (selected, id) => toggleFilterSelection(selected, id, statuses),
    statuses,
  );
  assert.deepEqual(cleared, []);
  const restored = statuses.reduce<string[]>(
    (selected, id) => toggleFilterSelection(selected, id, statuses),
    cleared,
  );
  assert.deepEqual(restored, statuses);
});

test("the generic multi-select helper can remove and restore an option", () => {
  const options = ["alpha", "beta"];
  const afterRemove = toggleFilterSelection(options, "beta", options);
  const afterRestore = toggleFilterSelection(afterRemove, "beta", options);
  assert.deepEqual(afterRemove, ["alpha"]);
  assert.equal(isAllSelected(afterRestore, options), true);
});

test("unrestricted facets render empty and first click creates an inclusion filter", () => {
  assert.deepEqual(activeFilterSelection(statuses, statuses), []);
  assert.deepEqual(toggleActiveFilterSelection(statuses, "ready", statuses), ["ready"]);
});

test("facet toggles return to unrestricted at zero or every option", () => {
  assert.deepEqual(toggleActiveFilterSelection(["ready"], "ready", statuses), statuses);
  assert.deepEqual(
    toggleActiveFilterSelection(["draft", "ready"], "archived", statuses),
    statuses,
  );
  assert.deepEqual(
    activeFilterSelection(["ready", "archived"], statuses),
    ["ready", "archived"],
  );
});

test("a nullable project facet can select its only option", () => {
  const projects = ["prj_only"];
  assert.deepEqual(activeNullableFilterSelection(null, projects), []);
  assert.deepEqual(toggleNullableFilterSelection(null, "prj_only", projects), projects);
  assert.equal(toggleNullableFilterSelection(projects, "prj_only", projects), null);
});

test("selecting every project remains a real filter that excludes Inbox", () => {
  const projects = ["prj_alpha", "prj_beta"];
  assert.deepEqual(
    toggleNullableFilterSelection(["prj_alpha"], "prj_beta", projects),
    projects,
  );
  assert.deepEqual(activeNullableFilterSelection(projects, projects), projects);
});

test("nullable project facets discard options that no longer exist", () => {
  const projects = ["prj_alpha", "prj_beta"];
  assert.deepEqual(
    activeNullableFilterSelection(["prj_stale", "prj_beta"], projects),
    ["prj_beta"],
  );
  assert.deepEqual(
    normalizeNullableFilterSelection(["prj_stale", "prj_beta"], projects),
    ["prj_beta"],
  );
  assert.equal(normalizeNullableFilterSelection(["prj_stale"], projects), null);
  assert.equal(normalizeNullableFilterSelection([], projects), null);
});
