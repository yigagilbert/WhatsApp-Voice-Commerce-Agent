# AG Grid and AG Studio in Katale AI

Katale AI uses two AG technologies in the merchant dashboard:

| Technology                  | Package                              | Licence            | Where                                 | What it does                                          |
| --------------------------- | ------------------------------------ | ------------------ | ------------------------------------- | ----------------------------------------------------- |
| **AG Grid Community** 36.3  | `ag-grid-react`, `ag-grid-community` | MIT                | Orders, Payments, Customers, Products | Operational grids                                     |
| **AG Studio** 3.1 (with AI) | `ag-studio-react`, `ag-studio`       | Commercial (trial) | Overview                              | The dashboard merchants land on, with an AI assistant |

Sponsor material used: the [PayPal + AG Studio hackathon post](https://www.ag-grid.com/blog/hackathon-paypal-and-ag-studio/),
the [PayPal + AG Grid boilerplate](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate),
the AG Studio [React quick start](https://www.ag-grid.com/studio/react/quick-start/),
[AI quick start](https://www.ag-grid.com/studio/react/ai-quickstart/) and the package type definitions.

## 1. Operational grids (AG Grid Community)

One shared component, [`components/grid/commerce-grid.tsx`](../../apps/web/components/grid/commerce-grid.tsx),
wraps `AgGridReact` with the dashboard's theme (`themeQuartz.withParams`) and adds:

- **Status chips** with live counts (external filter): Awaiting payment / Paid / Draft / Cancelled, etc.
- **Quick search** across all columns (`quickFilterText`).
- **Column filters**: text, number (amounts, quantities) and date (created, completed).
- **Sorting, resizing, pinned first column, pagination** (20 / 50 / 100).
- **Pinned summary row**: count and total of the rows currently passing the filters, recalculated on
  every filter change (only when all visible rows share one currency).
- **CSV export** of the filtered rows.
- **Row detail**: clicking an order opens a side panel with items, backend totals, payment status,
  the PayPal link (if unpaid) and a link to the full transaction trace.

| Grid      | Columns (all backed by real data)                                                                             | API                        |
| --------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Orders    | Order, Customer, Channel, Source (Voice/Text), Items, Amount, Currency, Payment status, Order status, Created | `GET /api/orders`          |
| Payments  | Order, Customer, Amount, Currency, Provider, Status, PayPal status, Requested, Completed, Trace, Link         | `GET /api/payments`        |
| Customers | Customer, Country, Orders, Paid orders, Revenue, Last order, Contact                                          | `GET /api/customers/stats` |
| Products  | Product, SKU, Price, Currency, Inventory, Units sold (paid), Revenue (paid), Active                           | `GET /api/products/stats`  |

Revenue in these grids is computed by the API from completed PayPal payments (integer minor units);
the grids only display and filter it.

## 2. Overview workspace (AG Studio)

The Overview is the analytics experience: AG Studio in view mode every day, edit mode behind
_Customize_. See [overview-redesign.md](overview-redesign.md) for the design, accounting rules, test
results and demo. Code: [`app/(dashboard)/overview`](<../../apps/web/app/(dashboard)/overview>).

Each assistant turn goes through the dashboard server, which holds the key:

```text
Katale AI assistant on AG Studio's harness (browser)
  → POST /studio-ai (same origin, dashboard session cookie required, rate limited)
  → OpenAI-compatible model (AI_BASE_URL / AI_API_KEY / AI_MODEL, server-side only)
  ← text and tool calls
  → the harness runs the tool in the browser against this merchant's records
```

`/studio-ai` is outside `/api`, so the public proxy never exposes it without the dashboard login.

**Licence.** AG Studio is commercial. Without `AG_STUDIO_LICENSE_KEY` it runs with all features
unlocked but shows a watermark and a console notice. A trial key is available from info@ag-grid.com;
set it in the VM `.env` ([steps](overview-redesign.md#8-deploying)). The operational grids use AG Grid Community (MIT) and need no key.

## Verification

| Check                                                                       | Result                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------ |
| Grids render real orders, payments, customers, products                     | PASS (local)                                           |
| Sorting, column filters, status chips, quick search, pagination, CSV export | PASS (local)                                           |
| Pinned total follows the filters                                            | PASS (local)                                           |
| Order detail panel                                                          | PASS (local)                                           |
| Phone width: no page-level horizontal scroll; grid scrolls inside its frame | PASS (local, 375 px)                                   |
| AG Studio and its assistant, real LLM                                       | PASS: see [overview-redesign.md](overview-redesign.md) |
| `/studio-ai` refuses requests without a dashboard session                   | PASS (401)                                             |
| Production                                                                  | See [PROJECT_STATUS.md](../../PROJECT_STATUS.md)       |

Unit tests: `apps/web/lib/dashboard-helpers.test.ts` (AG Studio → chat-completion mapping, activity
labels) and `apps/web/lib/overview-helpers.test.ts`. Grid data endpoints: `tests/integration/merchant-experience.test.ts`.
