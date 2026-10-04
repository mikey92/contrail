// Shipping cost in cents by total parcel weight.

export function shippingCost(weightGrams) {
  if (weightGrams <= 0) {
    return 0;
  }
  if (weightGrams <= 500) {
    return 499;
  }
  if (weightGrams <= 2000) {
    return 899;
  }
  return 1499;
}

export function parcelWeight(cart, catalog) {
  let grams = 0;
  for (const line of cart.lines) {
    grams += catalog.get(line.isbn).weightGrams * line.qty;
  }
  return grams;
}
