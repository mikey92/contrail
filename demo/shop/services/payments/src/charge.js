// Payments charges an order from the order JSON that the orders API sends.

/** The request sent to the card processor for an order. */
export function chargeRequest(orderJson, card) {
  if (!card?.token) throw new Error("a charge needs a card token");
  if (!(orderJson.total > 0)) throw new Error("nothing to charge");
  return {
    amount: orderJson.total,
    currency: "usd",
    source: card.token,
    description: `Order ${orderJson.id}`,
  };
}
