import assert from "node:assert/strict";
import { formatMoney } from "../src/money.js";

export function formatsDollars() {
  assert.equal(formatMoney(1999), "$19.99");
  assert.equal(formatMoney(5), "$0.05");
}
