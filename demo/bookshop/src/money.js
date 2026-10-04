// Money is always integer cents internally.

export function formatMoney(cents, currency = "USD") {
  const dollars = (cents / 100).toFixed(2);
  return currency === "USD" ? `$${dollars}` : `${dollars} ${currency}`;
}
