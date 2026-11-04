# Demo: from storefront to WhatsApp to PayPal (about 2 minutes)

**Story:** a shop with hundreds of products can't list them all in a chat. The customer browses a
real catalogue, then taps once and carries on with Katale AI on WhatsApp, where the AI handles
delivery, bargaining and the PayPal link.

> The website makes discovery easy. WhatsApp stays where the order happens.

## Setup

1. `pnpm db:deploy`, then `pnpm storefront:demo 120` for a catalogue with placeholder illustrations. For
   the video, upload real photos of your hero products instead.
2. Dashboard → **WhatsApp**: connect the shop's number and turn on customer shopping.
3. Dashboard → **Storefront**: publish, and check no warning appears.
4. Set `WEB_PUBLIC_URL` for both the API and web app.
5. Use a customer phone that **isn't an admin** of the shop. Admin numbers can't check out.

## Script

| Time | On screen                                                                     | Say                                                                                                  |
| ---- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 0:00 | WhatsApp: customer types _Show me all your products_; the bot sends the link  | "Listing hundreds of products in a chat doesn't work, so Katale sends the catalogue."                |
| 0:15 | Phone: storefront opens. Scroll, tap a category, search _basket_              | "No login and no app. Prices and stock come straight from the shop's database."                      |
| 0:35 | Product page: a quantity deal and "open to offers". Add to cart, 3 units      | "The discount comes from the backend. The browser only holds IDs and quantities."                    |
| 0:50 | Cart → **Checkout on WhatsApp**                                               | "One tap. The link carries an unguessable reference, and no prices."                                 |
| 1:00 | WhatsApp opens with the message ready. Send. The website says "has your cart" | "Only now does the checkout begin. The reference is bound to this customer and can't be used again." |
| 1:15 | Bot shows the cart and asks for name and delivery. Type _Can you do better?_  | "Same agent, same rules. It bargains, and the backend sets the limit it can never cross."            |
| 1:30 | Reply **ORDER**; PayPal link arrives. Pay in Sandbox                          | "The AI prepares, the customer confirms, PayPal executes."                                           |
| 1:45 | Payment confirmation in chat; dashboard order and stock updated               | "Same order, same stock ledger, same reconciliation as any WhatsApp order."                          |
| 1:55 | Dashboard → **Storefront**: QR code and share links                           | "One shop link for the stall, the flyer and the Status."                                             |

**If there's time:** send the same reference from a second phone to show it refused.

## Why this helps the PayPal AI Hackathon submission

- **Product design:** a clear answer to a limit of chat commerce, shown rather than described.
- **Merchant value:** a catalogue, QR code and share links, with nothing to maintain twice. Product
  changes appear on their own.
- **Agentic commerce:** the agent doesn't lose the sale to a website checkout. It receives the cart
  with context, gathers details, negotiates inside backend limits and hands off to PayPal.
- **Trust:** every price comes from the backend, at three checkpoints, and only the customer's own
  ORDER reply places an order.

## Before recording

[Not yet tested](../architecture/public-storefront.md#not-yet-tested) lists what hasn't run on real
accounts. Do one full rehearsal on a real phone with PayPal Sandbox first.
