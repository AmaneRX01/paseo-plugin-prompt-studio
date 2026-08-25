import assert from "node:assert/strict";
import test from "node:test";
import { draftDisplayCode, localDayKey } from "../src/client/studio/studio-formatters.client";

test("Draft display codes are stable three-character codes without ambiguous glyphs", () => {
  assert.equal(draftDisplayCode("dr_59bca304bc3b98d0"), "52S");
  assert.match(draftDisplayCode("dr_ffffffffffffffff"), /^[A-HJ-NP-Z2-9]{3}$/);
});

test("Each Draft display-code position is selected independently", () => {
  assert.equal(draftDisplayCode("dr_0000000000000000"), "AAA");
  assert.equal(draftDisplayCode("dr_0000000000010000"), "BAA");
  assert.equal(draftDisplayCode("dr_0000000000000100"), "ABA");
  assert.equal(draftDisplayCode("dr_0000000000000001"), "AAB");
});

test("Worklog groups UTC timestamps by the viewer's local calendar day", () => {
  assert.equal(localDayKey("2026-08-24T17:31:34.215Z", "Asia/Tokyo"), "2026-08-25");
  assert.equal(localDayKey("2026-08-24T17:31:34.215Z", "UTC"), "2026-08-24");
});
