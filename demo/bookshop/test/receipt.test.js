import assert from "node:assert/strict";
import { Cart } from "../src/cart.js";
import { createCatalog, SAMPLE_BOOKS } from "../src/catalog.js";
import { renderReceipt } from "../src/receipt.js";

export function rendersLinesAndTotal() {
  const cart = new Cart();
  cart.add("9781984801258", 2);
  const text = renderReceipt(cart, createCatalog(SAMPLE_BOOKS), 3400);
  assert.match(text, /2 x Klara and the Sun\s+\$34\.00/);
  assert.match(text, /TOTAL\s+\$34\.00/);
}
