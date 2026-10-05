import assert from "node:assert/strict";
import { chargeRequest } from "../src/charge.js";

const json = { id: "A-1001", items: [], total: 2100 };

export function chargesTheTotal() {
  assert.equal(chargeRequest(json, { token: "tok_visa" }).amount, 2100);
}

export function namesTheOrder() {
  assert.equal(chargeRequest(json, { token: "tok_visa" }).description, "Order A-1001");
}

export function refusesWithoutACard() {
  assert.throws(() => chargeRequest(json, {}), /card token/);
}
