import assert from "node:assert/strict";
import { orderJson, orderTotal } from "../src/orders.js";

const order = {
  id: "A-1001",
  lines: [
    { sku: "TEA-01", name: "Green tea", qty: 2, priceCents: 450 },
    { sku: "MUG-02", name: "Mug", qty: 1, priceCents: 1200 },
  ],
};

export function addsUpTheLines() {
  assert.equal(orderTotal(order.lines), 2100);
}

export function sendsTheTotal() {
  assert.equal(orderJson(order).total, 2100);
}

export function listsTheItems() {
  assert.deepEqual(
    orderJson(order).items.map((item) => item.sku),
    ["TEA-01", "MUG-02"],
  );
}
