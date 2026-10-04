import assert from "node:assert/strict";
import { Inventory } from "../src/inventory.js";

export function tracksStock() {
  const inv = new Inventory({ a: 3 });
  inv.take("a", 2);
  assert.equal(inv.available("a"), 1);
  assert.throws(() => inv.take("a", 2), /only 1 left/);
}
