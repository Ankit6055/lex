import { test } from "node:test";
import assert from "node:assert/strict";
import { createUser } from "../src/users.js";

test("createUser returns a user with an id", () => {
  const user = createUser({ name: "Ada", email: "ada@example.com", age: 36 });
  assert.equal(user.name, "Ada");
  assert.ok(user.id > 0);
});
