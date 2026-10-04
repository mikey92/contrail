# Bookshop

A tiny, dependency-free bookshop engine used as the demo codebase for Contrail.
Many agents improve it at the same time.

- `src/catalog.js` — the book catalog and search
- `src/cart.js` — the shopping cart
- `src/pricing.js` — subtotals, coupons, tax and totals (all money in integer cents)
- `src/shipping.js` — shipping rates
- `src/money.js` — money formatting
- `src/inventory.js` — stock levels
- `src/receipt.js` — printable receipts

Tests live in `test/*.test.js`. Every exported function is a test case and uses `node:assert`.
Run them locally with `node test/run.mjs`.
