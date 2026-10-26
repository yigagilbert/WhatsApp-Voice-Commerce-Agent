# HTTP API

Base URL: `http://localhost:4000`. All JSON. Errors have the shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [] }, "correlationId": "…" }
```

Every response carries `x-correlation-id` (sent by the caller or generated).

## Authentication

| Caller                  | Header                                      | Routes                                |
| ----------------------- | ------------------------------------------- | ------------------------------------- |
| Dashboard (server-side) | `Authorization: Bearer $API_AUTH_TOKEN`     | dashboard routes, agent (web channel) |
| Channel workers         | `x-internal-token: $INTERNAL_SERVICE_TOKEN` | `/api/agent/message`                  |
| PayPal                  | Signature headers (verified via PayPal)     | `/api/paypal/webhooks`                |
| Public                  | —                                           | health, PayPal return/cancel pages    |

Dashboard routes also identify the signed-in person: the dashboard server sends
`x-dashboard-user` (account ID) and `x-dashboard-session` (session version) from its signed cookie.
The API checks on every request that the account is active and the version current (a password
change, deactivation or role change ends older sessions → `401`), and uses the account's merchant.
Owner-only routes answer `403` to staff. While **no** dashboard account exists (first-time setup),
requests without these headers act as the owner of the merchant in `x-merchant-id` or the first
merchant; this setup mode ends when the first account is created.

## Endpoints

| Method | Path                             | Auth                 | Description                                                                                                              |
| ------ | -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/health`                    | public               | Liveness                                                                                                                 |
| GET    | `/api/health/ready`              | public               | DB check + which providers are configured                                                                                |
| POST   | `/api/agent/message`             | internal / dashboard | Process an `InboundChannelMessage`, returns replies                                                                      |
| GET    | `/api/customers`                 | dashboard            | List customers                                                                                                           |
| GET    | `/api/customers/:id`             | dashboard            | Customer detail                                                                                                          |
| POST   | `/api/customers`                 | dashboard            | Create customer `{ name, email?, phone?, whatsappId?, country? }`                                                        |
| GET    | `/api/products`                  | dashboard            | List products                                                                                                            |
| POST   | `/api/products`                  | dashboard            | Create product `{ name, unitPrice, currency?, sku?, stockQuantity? }`                                                    |
| GET    | `/api/orders?status=&limit=`     | dashboard            | List orders with items and customer                                                                                      |
| GET    | `/api/orders/:reference`         | dashboard            | Order by reference (`ORD-…`) or ID, with payments                                                                        |
| POST   | `/api/orders/:reference/cancel`  | dashboard            | Cancel an unpaid order (PayPal checked first; `409` if paid). Idempotent                                                 |
| GET    | `/api/payments?limit=`           | dashboard            | List payments (incl. `refundedMinor`)                                                                                    |
| POST   | `/api/payments/:id/refresh`      | dashboard            | Re-check a payment and its refunds with PayPal; returns it with refunds                                                  |
| POST   | `/api/auth/login`                | dashboard token      | `{ username, password }` → account + session version; `401` (same answer for every failure; `NO_ACCOUNTS` in setup mode) |
| GET    | `/api/auth/me`                   | dashboard            | Signed-in account and merchant                                                                                           |
| POST   | `/api/auth/password`             | dashboard            | `{ current, next }` → new session version (other sessions end)                                                           |
| GET    | `/api/dashboard-users`           | dashboard (owner)    | Dashboard accounts (never password hashes)                                                                               |
| POST   | `/api/dashboard-users`           | dashboard (owner)    | `{ username, name, role, password }`; the first one must be an owner                                                     |
| PATCH  | `/api/dashboard-users/:id`       | dashboard (owner)    | `{ name?, role?, active?, password? }`; last active owner protected                                                      |
| GET    | `/api/dashboard/summary`         | dashboard            | Revenue, outstanding, counts, recent orders/payments                                                                     |
| GET    | `/api/dashboard/activity?limit=` | dashboard            | Audit trail                                                                                                              |
| GET    | `/api/dashboard/messages?limit=` | dashboard            | Recent conversation messages incl. transcripts                                                                           |
| POST   | `/api/paypal/webhooks`           | signature            | PayPal webhook receiver (idempotent)                                                                                     |
| GET    | `/api/paypal/return`             | public               | Buyer return after approval → server-side capture                                                                        |
| GET    | `/api/paypal/cancel`             | public               | Buyer cancelled                                                                                                          |

There are intentionally **no** endpoints that create payment requests directly: financial actions
go through the confirmation flow (see `docs/architecture/financial-safety.md`).

## `POST /api/agent/message`

```json
{
  "channel": "whatsapp",
  "externalMessageId": "false_15550001111@c.us_3EB0…",
  "externalChatId": "15550001111@c.us",
  "senderId": "15550001111@c.us",
  "sentAt": "2026-10-05T10:00:00Z",
  "type": "audio",
  "media": { "mimeType": "audio/ogg; codecs=opus", "dataBase64": "T2dnUw…" }
}
```

Response:

```json
{
  "status": "processed",
  "replies": [
    {
      "channel": "whatsapp",
      "externalChatId": "15550001111@c.us",
      "text": "*Draft order ORD-7K2M9Q* …"
    }
  ]
}
```

`type` is `text`, `audio` (with `media`) or `unsupported` (with `unsupportedKind`: `voice`, `image`,
`video`, `document`, `sticker`, `location`, `contact`, `other`; no media). Unsupported content gets
a polite Katale AI reply.

`status` is `processed`, `duplicate` (already seen `externalMessageId`; no side effects) or
`ignored` (sender is not an operator). An `ignored` response may carry a throttled onboarding
reply showing the sender's channel ID, so the admin can register it with `pnpm operator:add`.

Example (web channel, from a terminal):

```bash
curl -s localhost:4000/api/agent/message -H "Authorization: Bearer $API_AUTH_TOKEN" -H 'content-type: application/json' -d '{"channel":"web","externalMessageId":"cli-1","externalChatId":"dashboard","senderId":"dashboard","sentAt":"2026-10-05T10:00:00Z","type":"text","text":"What products do we sell?"}'
```
