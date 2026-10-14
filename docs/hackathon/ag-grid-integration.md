# AG Grid and AG Studio in Katale AI

Katale AI uses two AG technologies in the merchant dashboard:

| Technology                  | Package                              | Licence            | Where                                 | What it does                                               |
| --------------------------- | ------------------------------------ | ------------------ | ------------------------------------- | ---------------------------------------------------------- |
| **AG Grid Community** 36.2  | `ag-grid-react`, `ag-grid-community` | MIT                | Orders, Payments, Customers, Products | Operational grids                                          |
| **AG Studio** 3.0 (with AI) | `ag-studio-react`, `ag-studio`       | Commercial (trial) | Analytics                             | Self-serve dashboards and an AI assistant that builds them |

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

## 2. Analytics workspace (AG Studio)

[`app/analytics`](../../apps/web/app/analytics) renders `AgStudio` over five data sources served by
`GET /api/dashboard/dataset`: orders, order items, payments, customers and products, joined by
relationships (order → items, order → payments, order → shipments, order → disputes, customer → orders),
plus shipments and disputes tables and an order `Fulfillment` field. Extra prompt starters:
_Paid orders not shipped_, _Disputed amount_. Field metadata (names,
descriptions, currency/date formats) tells both people and the assistant what each field means,
for example "Source: WhatsApp voice, WhatsApp text or Agent console".

**Default dashboard.** It opens on a "Sales overview" page: revenue and paid-order KPIs, revenue by
source (voice vs text), product revenue, and orders awaiting payment. This page was built by AG
Studio's own assistant from one request, captured with `api.getState()`, and stored in
[`default-report.ts`](../../apps/web/app/analytics/default-report.ts) with clearer titles. Merchants
can edit it, add pages and filters, or start again.

**AI assistant.** AG Studio's Agent Framework (`AgStudioAiModule` + `createAiHarness`) runs in the
browser and calls AG Studio's built-in, structured tools: read the schema, run queries, add and
configure widgets, set filters. The LLM never generates executable code and has no access to
payments or the commerce backend. The adapter
([`studio-adapter.ts`](../../apps/web/app/analytics/studio-adapter.ts)) sends each turn to the
dashboard server ([`app/studio-ai/route.ts`](../../apps/web/app/studio-ai/route.ts)):

```text
AG Studio assistant (browser)
  → POST /studio-ai (same origin, dashboard session cookie required, rate limited)
  → OpenAI-compatible model (AI_BASE_URL / AI_API_KEY / AI_MODEL, server-side only)
  ← text and tool calls
  → AG Studio executes its own tool (e.g. addWidget) against the in-browser data engine
```

The key never reaches the browser, and `/studio-ai` is outside `/api` so the public proxy never
exposes it without the dashboard login. Prompt starters: _Voice vs text revenue_, _Best-selling
products_, _Unpaid orders_, _Paid voice orders this week_.

**Licence.** AG Studio is commercial. Without `AG_STUDIO_LICENSE_KEY` it runs with all features
unlocked but shows a watermark and a console notice. A trial key is available from info@ag-grid.com;
set it in the VM `.env`. The operational grids use AG Grid Community (MIT) and need no key.

## Verification

| Check                                                                                                                   | Result                                           |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Grids render real orders, payments, customers, products                                                                 | PASS (local)                                     |
| Sorting, column filters, status chips, quick search, pagination, CSV export                                             | PASS (local)                                     |
| Pinned total follows the filters                                                                                        | PASS (local)                                     |
| Order detail panel                                                                                                      | PASS (local)                                     |
| Phone width: no page-level horizontal scroll; grid scrolls inside its frame                                             | PASS (local, 375 px)                             |
| AG Studio loads data sources and relationships                                                                          | PASS (local)                                     |
| AG Studio assistant via `/studio-ai`, real LLM: "Add a bar chart of order total for Paid orders by Source"              | PASS: chart built, filter Status = Paid          |
| Assistant built a 5-widget "Sales overview" page from one request; figures matched the backend ($286.00, 3 paid orders) | PASS                                             |
| `/studio-ai` refuses requests without a dashboard session                                                               | PASS (401)                                       |
| Production                                                                                                              | See [PROJECT_STATUS.md](../../PROJECT_STATUS.md) |

Unit tests: `apps/web/lib/dashboard-helpers.test.ts` (AG Studio → chat-completion mapping, highlights,
activity labels). Grid data endpoints: `tests/integration/merchant-experience.test.ts`.
