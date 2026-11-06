# Testing on a real WhatsApp number

Automated tests can't reach WhatsApp Web, so the stages inside it and quoted-message IDs need a
linked **test** number and a second phone. It takes about 30 minutes. Use a local stack and a
throwaway database, and never a shop's live number.

## Timing

Every message logs one `message processed` line with `stages` and `totalMs`:

| Stage      | What it covers                                                  |
| ---------- | --------------------------------------------------------------- |
| `queued`   | Waiting for this chat's earlier message                         |
| `download` | Voice notes only                                                |
| `quote`    | Library lookup, only when WhatsApp's own quote field is missing |
| `identity` | Resolving a linked ID to a phone (first message from a contact) |
| `api`      | The API, including any LLM or speech call                       |
| `send`     | Sending the replies                                             |

Send 20 messages per case and compare p50 and p95:

- A new contact against a known one
- A reply with a storefront link (`hi` from a new contact) against one without (`cart`)
- A customer number against an admin number

Targets: ticks and typing within 500 ms of receipt (watch the phone), and a p95 under 1.5 s for
replies that need no LLM.

## Quoted replies

The design assumes WhatsApp reports `_data.quotedStanzaID` and that it equals `id.id` of the message
we sent. Check that on a device. After each case below, look at the `messages` row for the reply and
whether the bot understood:

| Reply to                    | Say               | Expected                                       |
| --------------------------- | ----------------- | ---------------------------------------------- |
| A product photo             | How much is this? | Today's price for that product                 |
| The product details text    | How much is this? | The same                                       |
| An older numbered list      | 2                 | The second item of that list                   |
| A one-item cart             | Make it three     | Quantity 3 and a new cart                      |
| A placed order              | Make it three     | "already placed", nothing changes              |
| An offer                    | I'll take it      | Only if the offer is still open                |
| A CONFIRM prompt (merchant) | yes               | Asks for the code, nothing happens             |
| A customer alert (merchant) | Yes, we have it   | Sent to that customer, and says who it went to |

Log lines with `quoted message looked up through the library` mean WhatsApp's field was missing, so
count them and how often `found` is false. An unresolved quote is safe: the bot treats the quoted
text as the customer's words, or asks. It just isn't as smart.

Also confirm that blue ticks arrive on receipt rather than with the reply, that typing clears after
the reply, and that a location pin at the address step arrives with its coordinates.
