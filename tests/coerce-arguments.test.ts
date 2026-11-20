import assert from "node:assert/strict";
import test from "node:test";
import { coerceStringifiedArguments } from "../src/transcript.ts";

const schema = { type: "object", properties: { items: { type: "array" }, opts: { type: "object" }, name: { type: "string" } } };

test("parses a stringified array and object argument back to its declared type", () => {
  assert.deepEqual(coerceStringifiedArguments({ items: "[1,2]", opts: '{"a":1}' }, schema), { items: [1, 2], opts: { a: 1 } });
});

test("leaves string-typed, undeclared, mistyped and non-JSON values alone", () => {
  const args = { name: "[1]", extra: "[1]", items: "not json", opts: "[1]" };
  assert.equal(coerceStringifiedArguments(args, schema), args);
});

test("passes arguments through when there is no schema", () => {
  const args = { items: "[1]" };
  assert.equal(coerceStringifiedArguments(args, undefined), args);
});
