import assert from "node:assert/strict";
import { Cart } from "../src/cart.js";
import { createCatalog, SAMPLE_BOOKS } from "../src/catalog.js";
import { applyCoupon, subtotal, tax, total } from "../src/pricing.js";

const catalog = createCatalog(SAMPLE_BOOKS);

function cartOf(...entries) {
  const cart = new Cart();
  for (const [isbn, qty] of entries) cart.add(isbn, qty);
  return cart;
}

export function sumsLinePrices() {
  const cart = cartOf(["9780143127550", 2], ["9781984801258", 1]);
  assert.equal(subtotal(cart, catalog), 1800 * 2 + 1700);
}

export function appliesWelcomeCoupon() {
  assert.equal(applyCoupon(2000, "WELCOME5"), 1500);
  assert.equal(applyCoupon(300, "WELCOME5"), 0);
  assert.equal(applyCoupon(2000, "BOGUS"), 2000);
}

export function chargesCaliforniaTax() {
  assert.equal(tax(10000, "CA"), 725);
  assert.equal(tax(10000, "OR"), 0);
}

export function computesTotals() {
  const cart = cartOf(["9780593135204", 1]);
  assert.equal(total(cart, catalog, { region: "CA", coupon: "WELCOME5" }), 2399 + Math.round(2399 * 0.0725));
}
