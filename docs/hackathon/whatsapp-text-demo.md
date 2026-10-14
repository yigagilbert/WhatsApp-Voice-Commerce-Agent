# Katale AI — WhatsApp text demo

A reproducible run of the full commerce flow over real WhatsApp text. Verified on 2026-10-05.
For voice notes see the [voice demo](voice-demo.md).

## You need

- A **dedicated bot WhatsApp number** on a phone (linked as a device to Katale AI)
- A **merchant WhatsApp account** on another phone to send messages
- PayPal Sandbox credentials with a **US Sandbox business** account and a **Sandbox personal** buyer
- `AI_API_KEY` for an OpenAI-compatible model with tool calling
- Docker (Postgres) and Google Chrome (or a working Puppeteer Chrome)

## One-time setup

```bash
pnpm install
```

```bash
pnpm db:up
```

```bash
pnpm db:deploy
```

```bash
pnpm db:seed
```

```bash
pnpm paypal:check
```

```bash
pnpm ai:check
```

For a text-only run keep `VOICE_NOTES_ENABLED=false` (set `true` plus `STT_API_KEY` for voice). If Puppeteer's Chrome fails to launch, set
`WHATSAPP_CHROME_PATH` to an installed Chrome (see [WhatsApp integration](../architecture/whatsapp-integration.md#2-chrome--puppeteer)).

## Start

Terminal 1, the API and dashboard:

```bash
pnpm dev
```

Terminal 2, the WhatsApp worker:

```bash
pnpm dev:whatsapp
```

First run only: scan the QR from the **bot phone** (WhatsApp → Settings → Linked devices → Link a device).
Wait for `WhatsApp client ready`.

## Register the merchant (first time)

1. From the merchant phone, message the bot: `Hello`
2. Katale AI replies: _"This WhatsApp number isn't linked… Your WhatsApp ID: 2012…@lid"_
3. Register that ID:

```bash
pnpm operator:add 201234567890123@lid "Demo Owner"
```

## Demo script (≈ 4 minutes)

| #   | Merchant sends                                                                      | Katale AI replies                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `Create an order for Sarah for 10 handmade baskets at $12 each and $20 shipping.`   | _Katale AI · Draft order ORD-…_ — 10 × Handmade Basket @ $12.00 — $120.00 · Shipping — $20.00 · **Total — $140.00** · "Reply **CONFIRM 1234** to create the PayPal payment request…" |
| 2   | `CONFIRM 0000`                                                                      | "That code doesn't match the pending request…"                                                                                                                                       |
| 3   | `CONFIRM 1234` (the real code)                                                      | ✅ _Payment request created_ — Order, Customer, Amount $140.00, "Pay securely with PayPal:" + tappable link                                                                          |
| 4   | _(open the link on the demo laptop, log in as the Sandbox **personal** buyer, Pay)_ | Browser shows "Thank you!"; WhatsApp gets ✅ _Payment received_ — Order, Customer, Amount, "The order is now marked as paid."                                                        |
| 5   | `How much have I sold this week?`                                                   | Revenue, outstanding and top items from the database                                                                                                                                 |
| 6   | `Create an order for Sarah for some baskets.`                                       | "How many baskets…?"                                                                                                                                                                 |
| 7   | `5`                                                                                 | Draft for 5 baskets ($60.00) with a new code                                                                                                                                         |
| 8   | `CANCEL`                                                                            | "👍 Cancelled. Nothing was sent."                                                                                                                                                    |
| 9   | `Create an order for Sarah for 20 baskets at $1000 each.`                           | Draft with ⚠️ price-override warning and ⛔ "Payment requests above $10,000.00 are not allowed. No payment request was created."                                                     |
| 10  | a voice note                                                                        | `VOICE_NOTES_ENABLED=false`: "Voice messages are coming soon…"; `true`: handled like text ([voice demo](voice-demo.md))                                                              |

Show the dashboard (<http://localhost:3000>) alongside: **Overview** (revenue), **Payments**
(PayPal status `COMPLETED`, **Trace** link), and **Activity** (the whole transaction under one trace ID).

## Talking points

- The LLM interprets; **all amounts come from backend code**. The draft and payment messages are generated
  by the backend, not the model.
- Nothing financial happens without the merchant's **CONFIRM + code**. Wrong, expired and reused codes do nothing.
- Duplicate WhatsApp deliveries and repeated PayPal callbacks never duplicate orders, payments or notifications.
- One trace ID follows the transaction from WhatsApp message to payment notification.

## Troubleshooting on the day

| Problem                                   | Fix                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| No reply at all                           | Is the worker `ready`? Is the sender registered? Check the API log for `unknown sender` |
| "Something went wrong" reply              | Check the worker terminal for the error and correlation ID                              |
| Payment paid on a phone but no ✅ message | The phone can't reach `localhost`: pay on the laptop, or use a tunnel + webhook         |
| QR shown again after restart              | Session lost or unlinked: re-scan (the session dir is `.data/whatsapp-session`)         |
| WhatsApp misbehaves on stage              | Switch to the dashboard **Agent console**: same pipeline, same PayPal flow              |

## Production demo (https://kataleai.space)

The deployed stack runs the same flow with no laptop involvement: the bot number is linked to the
VM's `katale-whatsapp` container, and buyers pay from any device. PayPal's webhook completes the payment
even if the buyer closes the page. Before demoing:

```bash
ssh deploy@217.65.145.220 'cd /opt/apps/katale-ai && docker compose ps && docker compose logs --tail=20 whatsapp'
```

Check that all services are `healthy` and WhatsApp shows `client ready`. The dashboard asks for the
login configured in the VM `.env`. Make sure no local
`pnpm dev:whatsapp` is running against the same bot number.
