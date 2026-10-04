// Printable plain-text receipts.
import { formatMoney } from "./money.js";
import { findByIsbn } from "./catalog.js";

export function renderReceipt(cart, catalog, totalCents) {
  const rows = [];
  for (const line of cart.lines) {
    const book = findByIsbn(catalog, line.isbn);
    rows.push(`${line.qty} x ${book.title}  ${formatMoney(book.priceCents * line.qty)}`);
  }
  rows.push(`TOTAL  ${formatMoney(totalCents)}`);
  return rows.join("\n");
}
