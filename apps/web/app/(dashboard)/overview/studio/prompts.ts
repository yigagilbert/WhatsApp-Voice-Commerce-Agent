/** Questions merchants really ask. Each runs through AG Studio's own tools, against real records. */
export const PROMPT_STARTERS = [
  { label: 'How is this week going?', prompt: 'How is my business performing this week?' },
  { label: 'This week vs last', prompt: "Compare this week's sales with last week." },
  { label: 'Top products', prompt: 'Which products are generating the most revenue?' },
  { label: 'Low stock', prompt: 'Show me my low-stock products.' },
  { label: 'Pending PayPal payments', prompt: 'Which PayPal payments are still pending?' },
  { label: 'Paid, not shipped', prompt: "Which paid orders haven't been shipped?" },
  { label: 'Sales by product chart', prompt: 'Create a chart showing sales by product.' },
  {
    label: 'Build a dashboard',
    prompt: 'Build me a dashboard showing revenue, payments, and inventory performance.',
  },
];

/** How each assistant tool reads to a merchant, in both the Ask panel and Studio's own panel. */
export const TOOL_LABELS: Record<string, string> = {
  get_business_snapshot: 'Checked your business figures',
  list_pending_payments: 'Checked your PayPal payments',
  list_orders_to_ship: 'Checked your orders',
  list_stock_alerts: 'Checked your stock',
  top_products: 'Checked your product sales',
  top_customers: 'Checked your customers',
  revenue_by_channel: 'Checked your sales channels',
  sales_between: 'Checked your sales',
  execute_query: 'Looked through your records',
  view_schema: 'Reviewed your data',
  add_chart: 'Added a chart to the AI dashboard',
  add_table: 'Added a table to the AI dashboard',
  remove_widget: 'Removed from the AI dashboard',
};
