import assert from "node:assert/strict";
import { Cart } from "../src/cart.js";
import { createCatalog, SAMPLE_BOOKS } from "../src/catalog.js";
import { parcelWeight, shippingCost } from "../src/shipping.js";

export function pricesByWeight() {
  assert.equal(shippingCost(0), 0);
  assert.equal(shippingCost(450), 499);
  assert.equal(shippingCost(1200), 899);
  assert.equal(shippingCost(5000), 1499);
}

export function weighsParcels() {
  const cart = new Cart();
  cart.add("9780143127550", 2);
  assert.equal(parcelWeight(cart, createCatalog(SAMPLE_BOOKS)), 900);
}
