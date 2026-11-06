/**
 * Example conversations for the homepage. Each one is a workflow Katale AI supports today, with
 * sample data from the demo shop. Fixed-format replies (the customer menu and product details,
 * "Payment received", low-stock alerts, approval codes) use the bot's own wording; replies the
 * assistant words itself are representative.
 */

export type ChatMessage = {
  /** "me" is the person holding the phone (the merchant, or the customer in the shop demo). */
  from: 'me' | 'bot';
  kind?: 'text' | 'voice' | 'chart' | 'photo';
  /** WhatsApp-style text: *bold*, line breaks. For voice notes, what was said. */
  text: string;
  /** What happened behind the message, shown as a margin note. */
  note?: string;
  time: string;
};

export type ChatScript = {
  id: string;
  label: string;
  /** Whose phone this is, shown in the chat header. */
  title: string;
  subtitle: string;
  messages: ChatMessage[];
};

export const heroScript: ChatScript = {
  id: 'order',
  label: 'Order by voice',
  title: 'Katale AI',
  subtitle: 'Your shop assistant',
  messages: [
    {
      from: 'me',
      kind: 'voice',
      text: 'Create an order for Sarah for three handmade baskets and five dollars delivery.',
      note: 'Voice note transcribed',
      time: '09:41',
    },
    {
      from: 'bot',
      text: '*Draft order ORD-7K2Q · Sarah*\n3 × Handmade Basket @ $12.00 — $36.00\nDelivery — $5.00\n*Total — $41.00*\n\nReply *yes* to send Sarah a PayPal link.',
      note: 'Prices and total from your catalogue, computed by the backend',
      time: '09:41',
    },
    { from: 'me', text: 'yes', time: '09:42' },
    {
      from: 'bot',
      text: 'Reply *CONFIRM 4821* to send Sarah the PayPal link for $41.00.',
      note: 'One-time code, valid only for this order',
      time: '09:42',
    },
    { from: 'me', text: 'CONFIRM 4821', time: '09:42' },
    {
      from: 'bot',
      text: '✅ *Payment received*\n\nOrder: ORD-7K2Q\nCustomer: Sarah\nAmount: $41.00\n\nThe order is now marked as paid.',
      note: 'Sent once, after PayPal’s verified webhook',
      time: '09:58',
    },
  ],
};

export const demoScripts: ChatScript[] = [
  {
    id: 'stock',
    label: 'Low stock',
    title: 'Katale AI',
    subtitle: 'Your shop assistant',
    messages: [
      {
        from: 'bot',
        text: '⚠️ *Low stock:* Barkcloth Wallet — 6 left (reorder level 8).\nTell me when you restock, e.g. "add 50 Barkcloth Wallet".',
        note: 'Automatic alert when a sale takes stock below its reorder level',
        time: '11:05',
      },
      { from: 'me', text: 'Which products are running low?', time: '11:06' },
      {
        from: 'bot',
        text: 'Two products are at or below their reorder level:\n• *Barkcloth Wallet* — 6 left, about 4 days of sales. Suggested reorder: 30.\n• *Handmade Basket* — 9 left, about 6 days. Suggested reorder: 40.',
        note: 'From your stock and the last 30 days of sales',
        time: '11:06',
      },
      { from: 'me', text: 'I just received 30 wallets', time: '11:20' },
      {
        from: 'bot',
        text: 'Recorded: *Barkcloth Wallet* 6 → 36.',
        note: 'Stock movement saved with before and after',
        time: '11:20',
      },
    ],
  },
  {
    id: 'chart',
    label: 'Sales chart',
    title: 'Katale AI',
    subtitle: 'Your shop assistant',
    messages: [
      { from: 'me', text: 'Send me a chart of revenue this week', time: '18:30' },
      {
        from: 'bot',
        kind: 'chart',
        text: 'Revenue per day, last 7 days: $412.00.',
        note: 'Chart drawn from paid orders, not by the AI',
        time: '18:30',
      },
      { from: 'me', text: 'How much came from voice orders?', time: '18:31' },
      {
        from: 'bot',
        text: 'Voice orders: *9 orders, $268.00* this week, 65% of revenue.',
        time: '18:31',
      },
    ],
  },
  {
    id: 'shop',
    label: 'Customer shopping',
    title: 'Kampala Crafts',
    subtitle: 'Business account',
    messages: [
      { from: 'me', text: 'hi', time: '14:02' },
      {
        from: 'bot',
        text: 'Hello Amina! 👋 Welcome to *Kampala Crafts*.\n\nReply *browse* to see our products, *cart* for your cart, *orders* for your orders or *person* to talk to someone. Or just tell me what you’re looking for.',
        time: '14:02',
      },
      { from: 'me', text: 'browse', time: '14:02' },
      {
        from: 'bot',
        text: '*Our products*\n1. Barkcloth Wallet — $18.00 · Low stock\n2. Coffee Gift Pack — $25.00 · In stock\n3. Handmade Basket — $12.00 · In stock\n\nReply with a number for details, or ask me anything.',
        note: 'Availability only, never stock counts',
        time: '14:02',
      },
      { from: 'me', text: '3', time: '14:03' },
      { from: 'bot', kind: 'photo', text: 'Handmade Basket — $12.00', time: '14:03' },
      {
        from: 'bot',
        text: '*Handmade Basket*\n$12.00 · In stock\n\nWoven by hand in Kampala.\n\nReply *add* to put one in your cart (or e.g. *add 3*), *menu* for more options, or ask me a question.',
        time: '14:03',
      },
      { from: 'me', text: 'add 2', time: '14:03' },
      {
        from: 'bot',
        text: '🛒 *Your cart*\n2 × Handmade Basket — $24.00\n\nReply *checkout* to pay with PayPal.',
        note: 'Cart and total built by the backend',
        time: '14:03',
      },
    ],
  },
  {
    id: 'ship',
    label: 'Ship and track',
    title: 'Katale AI',
    subtitle: 'Your shop assistant',
    messages: [
      { from: 'me', text: 'Mark ORD-7K2Q shipped with DHL tracking 123456789', time: '16:10' },
      {
        from: 'bot',
        text: 'Reply *SHIP 3920* to mark ORD-7K2Q shipped and send DHL tracking 123456789 to PayPal.',
        note: 'Same rule as payments: you approve with a code',
        time: '16:10',
      },
      { from: 'me', text: 'SHIP 3920', time: '16:11' },
      {
        from: 'bot',
        text: '📦 ORD-7K2Q is marked shipped. The tracking number is on the PayPal transaction.',
        note: 'PayPal order tracking API',
        time: '16:11',
      },
    ],
  },
];
