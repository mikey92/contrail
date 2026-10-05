import assert from "node:assert/strict";
import { formatMoney, receiptLines } from "../src/receipt.js";

const json = {
  id: "A-1001",
  items: [
    { sku: "TEA-01", name: "Green tea", qty: 2, priceCents: 450 },
    { sku: "MUG-02", name: "Mug", qty: 1, priceCents: 1200 },
  ],
  total: 2100,
};

export function formatsCents() {
  assert.equal(formatMoney(2100), "$21.00");
}

export function listsEachItem() {
  assert.equal(receiptLines(json)[0], "2 × Green tea  $9.00");
}

export function endsWithTheTotal() {
  assert.equal(receiptLines(json).at(-1), "Total  $21.00");
}
