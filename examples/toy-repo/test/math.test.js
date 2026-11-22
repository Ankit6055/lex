import { test } from "node:test";
import assert from "node:assert/strict";
import { add, average } from "../src/math.js";

test("add adds two numbers", () => {
  assert.equal(add(2, 3), 5);
});

test("average of [2, 4, 6] is 4", () => {
  assert.equal(average([2, 4, 6]), 4);
});

test("average of [] is 0", () => {
  assert.equal(average([]), 0);
});
