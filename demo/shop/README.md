# Shop

A small monorepo in three sectors. Each sector is a directory with its own tower, runway and trunk:

| Sector | Directory | What it does |
| --- | --- | --- |
| Orders API | `services/orders/` | Builds the order JSON |
| Payments | `services/payments/` | Charges an order from its JSON |
| Storefront | `web/storefront/` | Renders the receipt from its JSON |

The order JSON is a contract between all three, so a change to it is a crossing: it lands in every
sector at once, or in none.

Run every sector's tests with `npm test`.
