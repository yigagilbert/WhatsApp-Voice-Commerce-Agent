# Katale AI: reliability and conversation improvements

**Date:** 2026-11-06 · **Branch:** `claude/katale-reliability-ux-improvements` · **Follows:** [the usability review](2026-11-06-katale-ai-usability-review.md)
**Status:** not merged or deployed. Nothing has run on a real WhatsApp device yet.

## Results against the audit

Conversation results use the real `gpt-4.1-mini` with a real Postgres and simulated PayPal, on the sequences that failed in the audit. Logs are in [`evidence/2026-11-06/`](evidence/2026-11-06/).

| Finding                                 | Audit                    | Now                                             |
| --------------------------------------- | ------------------------ | ----------------------------------------------- |
| P0-1 false "updated" claims             | 6 of 12                  | 0 of 12; the change really happened in 12 of 12 |
| P0-1 shown summary differs from DB      | $44 shown, $24 charged   | 12 of 12 matched                                |
| P0-2 customer text causes merchant tool | 12 of 12                 | 0 of 36                                         |
| P0-3 false hand-offs                    | 5 of 5                   | 0 of 16                                         |
| P0-4 chat stored as the address         | Reproduced twice         | 0 in 12 journeys                                |
| Journeys with corrections completed     | Failed on any correction | 12 of 12, right address and payment             |
| P0-5 lost items, overlapping adds       | 20 of 20                 | 0 of 20 (scripted LLM)                          |
| P0-5 order changed after placing        | 6 of 40                  | 0 of 40 (scripted LLM)                          |
| P0-6, P0-7, P0-8                        | Reproduced               | Fixed; regression tests with a scripted LLM     |
| Approval or price-floor bypass          | 0                        | Still 0                                         |

These are small samples. They show that the failures stopped on these sequences, not that the rate is zero.

## Latency: before and after

The same script ran on the base commit `742e4ef` and on this branch: API time to produce the reply, on this Mac beside a local database, with every response checked. WhatsApp Web's own stages aren't included. See [`before-after-latency.log.txt`](evidence/2026-11-06/before-after-latency.log.txt).

| Message                     | Before p50, p95 | After p50, p95 | LLM calls |
| --------------------------- | --------------- | -------------- | --------- |
| First "hi", n=60            | 5, 6 ms         | 5, 7 ms        | 0 to 0    |
| First "hi there", n=10      | 968, 1256 ms    | 5, 6 ms        | 1 to 0    |
| First "Hi 👋", n=10         | 943, 1200 ms    | 5, 6 ms        | 1 to 0    |
| "Hello, good morning", n=10 | 946, 1209 ms    | 5, 5 ms        | 1 to 0    |
| "good morning sir", n=10    | 994, 1177 ms    | 5, 7 ms        | 1 to 0    |
| Merchant "hi", n=10         | 874, 1345 ms    | 4, 14 ms       | 1 to 0    |
| Returning "hello", n=20     | 9, 20 ms        | 4, 8 ms        | 0 to 0    |
| "are you open?", n=8        | 2053, 2381 ms   | 2090, 2713 ms  | 2 to 2    |
| "do you have baskets?", n=8 | 1871, 2211 ms   | 2070, 3402 ms  | 2 to 2    |

**What this means.** Greeting variants and merchant greetings went from about 1 s to milliseconds. Exact "hi" was already fast. Questions that need the LLM are not faster and may be slightly slower, since each now loads facts for the model; these samples are too small to be sure. Those replies now feel faster only through instant ticks and typing, which need a device to confirm.

**Not measured.** The likely main cause of the slow first "hi" is the blocking link preview, now turned off. Its real effect needs [the device test](../development/whatsapp-device-test.md).

**A hung LLM** used to wait 30 s and then give a misleading reply. It now gets 7 s, one retry, then an honest message. A turn with several tool steps can take longer.

## Conversations, before and after

**Correcting a checkout**

```
Bot:      Where should we deliver?
Customer: wait add another one
Before:   Delivery: $0.00 to wait add another one … Reply ORDER
Now:      ✅ Handmade Basket: now 2.
          Where should we deliver? …
```

**A gift for a manager**

```
Customer: I am looking for a gift for my manager
Before:   I've let the team know… (then 12 hours of silence)
Now:      A normal answer. If they do ask for a person: "Reply bot any time to go back."
```

**Replying to a message.** With a product photo quoted, "How much is this?" gets today's price for that product. With a one-item cart quoted, "Make it three" changes the quantity and shows the new cart. With a placed order quoted, it says the order can't be changed here. A "yes" quoting a CONFIRM prompt only asks for the code.

**Unknown facts**

```
Customer: are you open?
Before:   Yes, Kampala Crafts is open.
Now:      The shop's opening hours are not provided…
```

**Reorders.** "order 20 more baskets" now gets "I can't order more baskets from suppliers…" and records nothing.

**Voice.** On synthetic clips, "Ntinda" was heard as "Nintendo" or "Tinder" without the new prompt and correctly with it. Noise and silence get "I couldn't hear that clearly", where they used to get `I heard: "Thank you for watching."`. See [`after-voice.log.txt`](evidence/2026-11-06/after-voice.log.txt).

## What else was found on the way

- **The worker was rate limited as one visitor.** All customers of all shops shared 120 requests a minute, so a busy shop would have failed. Fixed.
- **Saying the current price agreed to it.** "This bag is $30, can you do better?" could be read as an offer at $30, ending the bargaining. It failed 1 of 4 runs on the old code. Fixed, and 5 of 5 runs pass.
- **Merchant-made orders with a live link.** Cancelling one didn't tell the customer holding the link. Fixed.
- **`/whatsapp` and the Orders grid.** Not a product bug. In a tab that's in the background, React's streamed reveal waits for `requestAnimationFrame`, so the page stays on its loading state until the tab is shown. With a visible tab, both pages render normally in development and production. The audit saw this in a hidden pane. With the WhatsApp service down, `/whatsapp` now says so in plain language.

## OpenAI retirement dates

Confirmed on [OpenAI's deprecations page](https://developers.openai.com/api/docs/deprecations), and for `gpt-4.1-mini` also through the API's own `shutdown_date` field:

| Model          | Shuts down       | OpenAI's suggested replacement          |
| -------------- | ---------------- | --------------------------------------- |
| `gpt-4.1-mini` | 14 January 2027  | `gpt-6-luna`                            |
| `whisper-1`    | 26 February 2027 | `gpt-live-transcribe`, `gpt-transcribe` |

**No migration is recommended yet, because the replacements aren't drop-in:**

- `gpt-6-luna` refused Katale's requests. It rejects `temperature: 0.1`, and refuses function tools on Chat Completions unless `reasoning_effort` is `none`. So it hasn't been evaluated at all.
- `gpt-transcribe` handled the test clips, returning nothing on noise. But it reports no confidence score, so low-confidence read-backs would stop working, and with the prompt it heard "Mtinda" in the noisy clip.

## Tests

| Suite                                                           | Result                                                                                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (`pnpm test`)                                              | All pass                                                                                                                                                  |
| Integration, real Postgres (`pnpm test:integration`)            | 405 pass, with new regressions for every P0                                                                                                               |
| Real LLM, Whisper and PayPal Sandbox API (`pnpm test:external`) | 87 of 88 on the last full run. The one failure was an outdated expectation that cancelling is impossible; it was updated and that suite then passed twice |
| Dashboard and storefront in headless Chromium                   | See limits below                                                                                                                                          |

## Remaining limits and risks

**Not tested**

- **Real WhatsApp.** No linked device was used. Link-preview, typing, ticks, stage timings, location pins and quoted-message IDs are all covered by code and unit tests only. **Reply-to depends on an assumption about WhatsApp's IDs** that a device has to confirm; if it's wrong, quotes fall back safely to the customer's own words.
- **PayPal.** Sandbox API calls passed, but no buyer approved a payment in this work. Conversation tests simulate PayPal.
- **Real accents.** All voice clips are synthetic. Ugandan English accuracy is unknown, and the confidence score didn't catch wrong place names.
- **Dashboard.** API key, report schedule, Status ad and Status settings forms were only typechecked. The WhatsApp shop settings form never rendered in testing because the test shops have no linked account. "Ready to sell" has unit tests only.

**Known gaps**

- **One API instance.** The per-chat queue is in memory. A second instance would keep carts safe through the database lock, but replies could overlap. Today's deployment runs one.
- **UGX shops still can't take payment online.** They now get an honest message instead of a false one. The warning tells merchants to price in USD, but the dashboard has no currency setting, so a merchant can't act on it themselves.
- **Address and hand-off rules are heuristics.** Tests cover about 100 sentences. Unusual wording will get past them, and the customer can still correct it at the summary.
- **Speech biasing costs time on silence.** A silent or very noisy note took up to about 10 s against about 1.5 s without the prompt, before the retry message.
- **Next.js internals.** Session-expiry redirects use the undocumented `x-action-redirect` header. A test pins what we send and an error boundary is the fallback.
- **Double checkout** is prevented per browser only. Another browser, or cleared storage, isn't covered.

**Not done from the audit:** phone layouts for merchants (P1-18), pairing by code (P1-19), shipping and disputes in the dashboard (P1-21), jargon and settings clean-up (P2-7, P2-8), field-level form errors (P2-10), password recovery (P2-13), scoping "no deal" to one product (P2-4), telling customers about shipment (P2-14), cutting merchant tokens (P2-15), merging rapid messages into one answer, and a merchant inbox.

## Deployment

1. **Set `AI_TIMEOUT_MS=7000` in production.** The server's `.env` sets 30000, which with the new retry could wait 60 s.
2. **Run the migration.** `20261106120000_message_kind_quotes` adds columns and an index, and an enum value. It also relabels existing merchant alerts, so they stop reaching the agent.
3. **Deploy the API and web, then the worker.** A new worker tolerates an old API, and vice versa; quoted replies just don't resolve until both are live.
4. **Run the [device test](../development/whatsapp-device-test.md)** on a test number before relying on reply-to or the latency improvement.

`VOICE_NOTES_ENABLED` now covers customers too, so if customer shopping is on, each customer voice note costs a speech call. Per-customer message limits still apply.

## Rollback

Set `KATALE_TAG` to the previous release and re-run `vm-deploy.sh`. The new columns are harmless to older code, and no data needs restoring. Before rolling back, clear any pending cancellation, since the old code doesn't know this action:

```sql
UPDATE action_confirmations SET status = 'CANCELLED' WHERE action = 'CANCEL_ORDER' AND status = 'PENDING';
```

The enum value stays in the database, which is harmless.
