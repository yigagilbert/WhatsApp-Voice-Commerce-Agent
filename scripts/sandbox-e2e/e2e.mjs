// End-to-end validation against a local API wired to REAL PayPal Sandbox and a real LLM.
// Buyers "pay" with PayPal's published Sandbox test card (confirm-payment-source); refunds are
// Sandbox refunds. WhatsApp is simulated at the worker boundary (POST /api/agent/message, outbound
// captured by catcher.mjs). No production system is touched.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Sandbox keys: read from this .env (default: the repo's), never printed. DB: the E2E container.
const ENV_FILE = process.env.E2E_ENV_FILE ?? resolve(here, '../../.env');
const PG = process.env.E2E_PG_CONTAINER ?? 'katale-e2e-pg';

const API = 'http://127.0.0.1:4011';
const PP = 'https://api-m.sandbox.paypal.com';
const INTERNAL = 'e2e-internal-token-1234567';
const DASH = 'e2e-dashboard-token-1234567';
const MERCHANT = 'seed_merchant_kampala_crafts';
const BOT = '256700000999@c.us';
const ADMIN = '256711000001@c.us';
const run = Date.now().toString().slice(-6);
const JANE = `25678${run}1@c.us`;
const EVENTS = resolve(here, 'events.jsonl');

const env = Object.fromEntries(
  readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter((l) => /^PAYPAL_CLIENT_(ID|SECRET)=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const results = [];
let current = '';
const scenario = (name) => {
  current = name;
  console.log(`\n=== ${name}`);
};
const blocked = (what, reason) => {
  results.push({ scenario: current, what, ok: null, detail: reason });
  console.log(`BLOCKED  ${what} — ${reason}`);
};
const check = (what, ok, detail = '') => {
  results.push({ scenario: current, what, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`,
  );
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) =>
  execSync(`docker exec -i ${PG} psql -U vca -d vca -tA -F '|'`, { input: q }).toString().trim();

const agent = async (from, text) => {
  const res = await fetch(`${API}/api/agent/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL },
    body: JSON.stringify({
      channel: 'whatsapp',
      externalMessageId: `e2e-${run}-${Math.random().toString(36).slice(2)}`,
      externalChatId: from,
      senderId: from,
      sentAt: new Date().toISOString(),
      type: 'text',
      text,
      recipientId: BOT,
    }),
  });
  const body = await res.json();
  return (body.replies ?? []).map((r) => r.text).join('\n') || JSON.stringify(body);
};
let dashHeaders = { authorization: `Bearer ${DASH}`, 'content-type': 'application/json' };
const dash = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: dashHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const events = (kind) =>
  existsSync(EVENTS)
    ? readFileSync(EVENTS, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => !kind || e.kind === kind)
    : [];
const sentTo = (chat, since = 0) =>
  events('whatsapp')
    .filter((e) => e.at >= since && e.body.externalChatId === chat)
    .map((e) => e.body.text);

let ppToken;
const pp = async (method, path, body) => {
  ppToken ??= (
    await fetch(`${PP}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    }).then((r) => r.json())
  ).access_token;
  const res = await fetch(`${PP}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ppToken}`,
      'content-type': 'application/json',
      'paypal-request-id': `e2e-${run}-${Math.random().toString(36).slice(2)}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
/** The Sandbox buyer approves with PayPal's published test card (no money, no login). */
const buyerApproves = (paypalOrderId) =>
  pp('POST', `/v2/checkout/orders/${paypalOrderId}/confirm-payment-source`, {
    payment_source: {
      card: {
        number: '4111111111111111',
        expiry: '2030-12',
        security_code: '123',
        name: 'Sandbox Buyer',
      },
    },
  });
const returnPage = async (token) => (await fetch(`${API}/api/paypal/return?token=${token}`)).text();
const webhook = (eventType, resource) =>
  fetch(`${API}/api/paypal/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: `WH-E2E-${run}-${Math.random().toString(36).slice(2)}`,
      event_type: eventType,
      resource,
    }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const orderRow = (ref) => {
  const [status, refunded, cancelReason, attention, total] = sql(
    `select status, "refundedMinor", coalesce("cancelReason"::text,''), coalesce(attention::text,''), "totalMinor" from orders where reference='${ref}'`,
  ).split('|');
  return { status, refunded: Number(refunded), cancelReason, attention, total: Number(total) };
};
const paymentRow = (ref) => {
  const [id, status, refunded, externalId, captureId] = sql(
    `select p.id, p.status, p."refundedMinor", p."externalId", coalesce(p."captureId",'') from payments p join orders o on o.id=p."orderId" where o.reference='${ref}' order by p."createdAt" desc limit 1`,
  ).split('|');
  return { id, status, refunded: Number(refunded), externalId, captureId };
};
const stock = (name) => Number(sql(`select "stockQuantity" from products where name='${name}'`));
const productNumber = (list, name) => list.match(new RegExp(`(\\d+)\\. ${name}`))?.[1];

/** Customer: browse → add → checkout → ORDER; returns { ref, paypalOrderId, link }. */
async function customerOrder(qty, product = 'Handmade Basket') {
  await agent(JANE, 'menu');
  const list = await agent(JANE, '1');
  const n = productNumber(list, product);
  await agent(JANE, `add ${qty} of ${n}`);
  let step = await agent(JANE, 'checkout');
  if (/What name/.test(step)) step = await agent(JANE, 'Jane E2E');
  const placed = await agent(JANE, 'ORDER');
  const link = placed.match(/https:\/\/\S+token=([A-Z0-9]+)/);
  const ref = placed.match(/ORD-[A-Z0-9]{6}/)?.[0];
  return { ref, paypalOrderId: link?.[1], link: link?.[0], placed, step };
}

// ─────────────────────────────────────────────────────────────────────────────
scenario('A. Customer order → Sandbox payment → partial and full refunds');
{
  const before = stock('Handmade Basket');
  const t0 = Date.now();
  const o = await customerOrder(2);
  check(
    'customer gets an order reference and a real Sandbox PayPal link',
    o.ref && o.link?.includes('sandbox.paypal.com'),
    o.placed,
  );
  check(
    'order awaits payment with a due time',
    orderRow(o.ref).status === 'AWAITING_PAYMENT' &&
      sql(`select "paymentDueAt" is not null from orders where reference='${o.ref}'`) === 't',
  );
  check(
    'admins told about the new order',
    sentTo(ADMIN, t0).some((t) => t.includes(o.ref)),
  );
  const approve = await buyerApproves(o.paypalOrderId);
  check(
    'Sandbox buyer approval (test card)',
    approve.body?.status === 'APPROVED',
    approve.body?.status ?? JSON.stringify(approve.body),
  );
  const page = await returnPage(o.paypalOrderId);
  const captureRefused = !page.includes('Payment successful');
  if (captureRefused) {
    // This Sandbox seller isn't enabled for card capture: a test-card approval can't be captured.
    check(
      'capture refused by PayPal → order stays awaiting payment, nothing recorded, stock untouched',
      orderRow(o.ref).status === 'AWAITING_PAYMENT' &&
        paymentRow(o.ref).status !== 'COMPLETED' &&
        stock('Handmade Basket') === before,
      JSON.stringify(paymentRow(o.ref)),
    );
    check('buyer sees "Payment processing", not success', page.includes('Payment processing'));
    for (const step of [
      'capture + stock deduction + customer thank-you',
      'partial refund recorded from PayPal',
      'refund webhook idempotency with the real resource',
      'full refund → REFUNDED, no restock',
    ])
      blocked(
        step,
        'needs a Sandbox buyer (PayPal login) to approve: card capture is not enabled for this Sandbox seller',
      );
  } else {
    const pay = paymentRow(o.ref);
    check(
      'order PAID, payment COMPLETED with a capture ID',
      orderRow(o.ref).status === 'PAID' && pay.status === 'COMPLETED' && pay.captureId,
      JSON.stringify(pay),
    );
    check(
      'stock deducted once (−2)',
      stock('Handmade Basket') === before - 2,
      `${before} → ${stock('Handmade Basket')}`,
    );
    check(
      'customer thanked on WhatsApp',
      sentTo(JANE, t0).some((t) => t.includes('Payment received')),
    );
    await returnPage(o.paypalOrderId);
    check(
      'return URL replay: still one capture, stock unchanged',
      stock('Handmade Basket') === before - 2,
    );

    // Partial refund made "in PayPal" (Sandbox REST); the merchant checks it in the dashboard.
    const r1 = await pp('POST', `/v2/payments/captures/${pay.captureId}/refund`, {
      amount: { value: '5.00', currency_code: 'USD' },
    });
    check(
      'Sandbox partial refund created',
      ['COMPLETED', 'PENDING'].includes(r1.body?.status),
      `${r1.status} ${r1.body?.status}`,
    );
    const refresh = await dash('POST', `/api/payments/${pay.id}/refresh`, {});
    check(
      'PayPal GET order reports the refund; dashboard refresh records it',
      refresh.body?.refundedMinor === 500 && refresh.body?.status === 'COMPLETED',
      JSON.stringify({
        s: refresh.status,
        r: refresh.body?.refundedMinor,
        st: refresh.body?.status,
      }),
    );
    const partial = orderRow(o.ref);
    check(
      'order stays PAID with $5 refunded',
      partial.status === 'PAID' && partial.refunded === 500,
      JSON.stringify(partial),
    );
    // The real refund resource, delivered as PayPal's webhook would (signature check skipped locally).
    const resource1 = await pp('GET', `/v2/payments/refunds/${r1.body.id}`);
    const wh1 = await webhook('PAYMENT.CAPTURE.REFUNDED', resource1.body);
    check(
      'refund webhook with the real resource is processed and idempotent (1 refund row)',
      wh1.body?.outcome === 'processed' &&
        sql(`select count(*) from refunds where "paymentId"='${pay.id}'`) === '1',
      JSON.stringify(wh1.body),
    );
    const r2 = await pp('POST', `/v2/payments/captures/${pay.captureId}/refund`, {
      amount: { value: '19.00', currency_code: 'USD' },
    });
    const resource2 = await pp('GET', `/v2/payments/refunds/${r2.body.id}`);
    const t1 = Date.now();
    await webhook('PAYMENT.CAPTURE.REFUNDED', resource2.body);
    const after = orderRow(o.ref);
    check(
      'remaining refund → order and payment REFUNDED',
      after.status === 'REFUNDED' &&
        after.refunded === 2400 &&
        paymentRow(o.ref).status === 'REFUNDED',
      JSON.stringify(after),
    );
    check('refund never restocks automatically', stock('Handmade Basket') === before - 2);
    check(
      'admins told "do not ship"; customer told about the refund',
      sentTo(ADMIN, t1).some((t) => t.includes('Order refunded') && t.includes('Do not ship')) &&
        sentTo(JANE, t1).some((t) => t.includes('refund')),
    );
  }
}

scenario('B. Customer cancels on WhatsApp; paying the cancelled link takes no money');
{
  const o = await customerOrder(3);
  const reserved = Number(
    sql(
      `select coalesce(sum(i.quantity),0) from order_items i join orders o on o.id=i."orderId" where o.status='AWAITING_PAYMENT' and i.description='Handmade Basket'`,
    ),
  );
  check('order placed and holding stock', o.ref && reserved >= 3, `reserved ${reserved}`);
  const orders = await agent(JANE, 'orders');
  check('"orders" explains how to cancel', orders.includes('cancel ORD-'));
  const reply = await agent(JANE, `cancel ${o.ref.toLowerCase()}`);
  check(
    'customer cancels their own unpaid order',
    reply.includes('is cancelled') && orderRow(o.ref).cancelReason === 'CUSTOMER',
    reply,
  );
  const reservedAfter = Number(
    sql(
      `select coalesce(sum(i.quantity),0) from order_items i join orders o on o.id=i."orderId" where o.status='AWAITING_PAYMENT' and i.description='Handmade Basket'`,
    ),
  );
  check('reservation released', reservedAfter === reserved - 3, `${reserved} → ${reservedAfter}`);
  check(
    'repeat cancel is harmless',
    (await agent(JANE, `cancel ${o.ref}`)).includes('already cancelled'),
  );
  await buyerApproves(o.paypalOrderId);
  const page = await returnPage(o.paypalOrderId);
  const ppOrder = await pp('GET', `/v2/checkout/orders/${o.paypalOrderId}`);
  check(
    'buyer returning from the cancelled link sees "Order cancelled"',
    page.includes('Order cancelled'),
  );
  check(
    'PayPal order NOT captured (still APPROVED)',
    ppOrder.body?.status === 'APPROVED',
    ppOrder.body?.status,
  );
}

scenario('C. Buyer approved just before the merchant cancels → paid, not cancelled');
{
  const o = await customerOrder(1);
  await buyerApproves(o.paypalOrderId);
  const res = await dash('POST', `/api/orders/${o.ref}/cancel`, {});
  // Katale sees APPROVED at PayPal and captures instead of cancelling. Here PayPal refuses the
  // capture (card processing off), so the safe outcome is: not cancelled, error shown, retry later.
  check(
    'approved order is NOT cancelled (PayPal asked first; capture attempted)',
    orderRow(o.ref).status !== 'CANCELLED',
    JSON.stringify({ http: res.status, body: res.body }),
  );
  check(
    'dashboard gets a plain error with a reference, no PayPal internals',
    res.status >= 400 &&
      /reference/.test(res.body?.error?.message ?? '') &&
      !/UNPROCESSABLE|PAYEE_/.test(JSON.stringify(res.body)),
    res.body?.error?.message,
  );
}

scenario('D/E. Capture completing after cancellation (return page, reconciler)');
blocked(
  'late capture recorded, PAID_AFTER_CANCEL, SHIP blocked until review',
  'needs a captured Sandbox payment (buyer login); covered by integration tests with simulated PayPal',
);
blocked('reconciler recovers a capture on a cancelled link', 'same');

scenario('F. Unpaid order expires on its own');
{
  const o = await customerOrder(1);
  const t0 = Date.now();
  sql(`update orders set "paymentDueAt" = now() - interval '1 minute' where reference='${o.ref}'`);
  let row;
  for (let i = 0; i < 20; i++) {
    await sleep(6000);
    row = orderRow(o.ref);
    if (row.status === 'CANCELLED') break;
  }
  check(
    'scheduler cancelled it (PAYMENT_EXPIRED) after checking PayPal',
    row.status === 'CANCELLED' && row.cancelReason === 'PAYMENT_EXPIRED',
    JSON.stringify(row),
  );
  check(
    'customer and admins told',
    sentTo(JANE, t0).some((t) => t.includes("wasn't paid in time")) &&
      sentTo(ADMIN, t0).some((t) => t.includes('not paid in time')),
  );
}

scenario('G. WhatsApp admin assistant (real LLM) and dashboard figures');
{
  const sales = await agent(ADMIN, 'How much have I sold today?');
  check('admin sales question answered from the database', /\$\d/.test(sales), sales);
  const unpaid = await agent(ADMIN, 'Which orders are still awaiting payment?');
  check('admin "awaiting payment" question answered', unpaid.length > 10, unpaid);
  const summary = await dash('GET', '/api/dashboard/summary');
  const expected = Number(
    sql(
      `select coalesce(sum("amountMinor" - "refundedMinor"),0) from payments where "merchantId"='${MERCHANT}' and status='COMPLETED'`,
    ),
  );
  const usd = summary.body?.revenue?.find((r) => r.currency === 'USD');
  check(
    'USD revenue = completed payments net of refunds',
    (usd?.amountMinor ?? 0) === expected,
    `${usd?.amountMinor ?? 0} vs ${expected}`,
  );
  const orders = Number(
    sql(
      `select count(*) from orders where "merchantId"='${MERCHANT}' and not ("placedBy"='CUSTOMER' and status='DRAFT' and "customerConfirmedAt" is null)`,
    ),
  );
  check(
    'order count excludes open carts',
    summary.body?.counts?.orders === orders,
    `${summary.body?.counts?.orders} vs ${orders}`,
  );
  dashHeaders = { ...dashHeaders, 'x-merchant-id': 'ugx_e2e' };
  const ugx = await dash('GET', '/api/dashboard/summary');
  const ugxData = await dash('GET', '/api/dashboard/dataset');
  check(
    'UGX revenue shown whole (UGX 50,000)',
    ugx.body?.revenue?.[0]?.formatted?.replace(/\s/g, ' ') === 'UGX 50,000',
    ugx.body?.revenue?.[0]?.formatted,
  );
  check(
    'UGX dataset total 50000 (not 500)',
    ugxData.body?.orders?.[0]?.total === 50000,
    ugxData.body?.orders?.[0]?.total,
  );
  delete dashHeaders['x-merchant-id'];
}

scenario('H. Dashboard accounts: setup → owner → roles → revocation');
{
  const login = (username, password) =>
    fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { authorization: `Bearer ${DASH}`, 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check(
    'setup mode reported while no accounts exist',
    (await login('x', 'y y y y y y y')).body?.error?.code === 'NO_ACCOUNTS',
  );
  const owner = await dash('POST', '/api/dashboard-users', {
    username: 'e2e-owner',
    name: 'E2E Owner',
    role: 'OWNER',
    password: 'e2e owner passphrase',
  });
  check('first owner created from setup mode', owner.status === 201);
  check(
    'setup mode refused once an account exists',
    (await dash('GET', '/api/orders')).status === 401,
  );
  const o = (await login('e2e-owner', 'e2e owner passphrase')).body.user;
  dashHeaders = {
    authorization: `Bearer ${DASH}`,
    'content-type': 'application/json',
    'x-dashboard-user': o.id,
    'x-dashboard-session': String(o.sessionVersion),
  };
  const staff = await dash('POST', '/api/dashboard-users', {
    username: 'e2e-staff',
    name: 'E2E Staff',
    role: 'STAFF',
    password: 'e2e staff passphrase',
  });
  const s = (await login('e2e-staff', 'e2e staff passphrase')).body.user;
  const ownerHeaders = dashHeaders;
  dashHeaders = {
    ...ownerHeaders,
    'x-dashboard-user': s.id,
    'x-dashboard-session': String(s.sessionVersion),
  };
  check('staff can read orders', (await dash('GET', '/api/orders')).status === 200);
  check(
    'staff cannot manage admins or accounts',
    (await dash('POST', '/api/admins', {})).status === 403 &&
      (await dash('GET', '/api/dashboard-users')).status === 403,
  );
  dashHeaders = ownerHeaders;
  await dash('PATCH', `/api/dashboard-users/${staff.body.id}`, { active: false });
  dashHeaders = {
    ...ownerHeaders,
    'x-dashboard-user': s.id,
    'x-dashboard-session': String(s.sessionVersion),
  };
  check(
    'deactivated staff session is refused immediately',
    (await dash('GET', '/api/orders')).status === 401,
  );
  const adminMsg = await agent(ADMIN, 'How many products do I have?');
  check(
    'WhatsApp admins unaffected by dashboard accounts',
    adminMsg.length > 5 && !/welcome/i.test(adminMsg),
    adminMsg,
  );
}

scenario('I. Monitoring');
{
  check(
    'scheduler heartbeat pinged',
    events('heartbeat').length >= 1,
    `${events('heartbeat').length} pings`,
  );
  const alerts = events('alert').map((a) => a.body.title);
  check(
    'the refused capture raised an operator alert (and nothing else did)',
    alerts.length > 0 && alerts.every((t) => /capture failed/.test(t)),
    alerts.join('; '),
  );
}

const failed = results.filter((r) => r.ok === false);
writeFileSync(resolve(here, 'results.json'), JSON.stringify(results, null, 2));
const passed = results.filter((r) => r.ok === true).length;
console.log(
  `\n${passed} passed, ${failed.length} failed, ${results.length - passed - failed.length} blocked`,
);
process.exit(failed.length ? 1 : 0);
