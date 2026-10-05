// The storefront's receipt, rendered from the order JSON that the orders API sends.

export function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/** One line per item, then the total. */
export function receiptLines(orderJson) {
  return [
    ...orderJson.items.map((item) => `${item.qty} × ${item.name}  ${formatMoney(item.priceCents * item.qty)}`),
    `Total  ${formatMoney(orderJson.total)}`,
  ];
}
