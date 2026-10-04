// Pricing rules for an order. All amounts are integer cents.
import { findByIsbn } from "./catalog.js";

export function subtotal(cart, catalog) {
  let total = 0;
  for (const line of cart.lines) {
    const book = findByIsbn(catalog, line.isbn);
    if (!book) {
      throw new Error(`unknown isbn ${line.isbn}`);
    }
    total += book.priceCents * line.qty;
  }
  return total;
}

export function applyCoupon(amount, code) {
  if (code === "WELCOME5") {
    return Math.max(0, amount - 500);
  }
  return amount;
}

export function tax(amount, region) {
  if (region === "CA") {
    return Math.round(amount * 0.0725);
  }
  return 0;
}

export function total(cart, catalog, { coupon = null, region = "OR" } = {}) {
  const sub = subtotal(cart, catalog);
  const discounted = coupon ? applyCoupon(sub, coupon) : sub;
  return discounted + tax(discounted, region);
}
