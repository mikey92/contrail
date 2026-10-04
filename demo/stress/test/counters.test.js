import assert from "node:assert/strict";
import * as counters from "../src/counters.js";
import * as notes from "../src/notes.js";

export function countersAreNonNegativeIntegers() {
  for (const [name, fn] of Object.entries(counters)) {
    const v = fn();
    assert.ok(Number.isInteger(v) && v >= 0, `${name} returned ${v}`);
  }
}

export function notesAreCallable() {
  for (const fn of Object.values(notes)) assert.equal(fn(), true);
}
