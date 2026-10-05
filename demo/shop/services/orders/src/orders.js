// The order JSON: what payments charges and what the storefront renders. Its shape is a contract
// between three sectors, so a change to it lands in all of them at once.

/** The order's total in cents: each line's price times its quantity. */
export function orderTotal(lines) {
  return lines.reduce((sum, line) => sum + line.priceCents * line.qty, 0);
}

/** The JSON the orders API sends for an order. */
export function orderJson(order) {
  return {
    id: order.id,
    items: order.lines.map((line) => ({ sku: line.sku, name: line.name, qty: line.qty, priceCents: line.priceCents })),
    total: orderTotal(order.lines),
  };
}
