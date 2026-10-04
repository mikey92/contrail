import assert from "node:assert/strict";
import { Cart } from "../src/cart.js";

export function addsLines() {
  const cart = new Cart();
  cart.add("a", 2);
  cart.add("b");
  assert.equal(cart.count(), 3);
}

export function rejectsNonPositiveQuantities() {
  const cart = new Cart();
  assert.throws(() => cart.add("a", 0));
}

export function removesLines() {
  const cart = new Cart();
  cart.add("a", 2);
  cart.add("b", 1);
  cart.remove("a");
  assert.equal(cart.count(), 1);
}
