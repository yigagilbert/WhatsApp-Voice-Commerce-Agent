# Katale AI — WhatsApp voice demo

One story: a merchant **speaks** an order into WhatsApp, approves it by text, the buyer pays with
PayPal, and the merchant hears back. The full five-minute version is
[final-demo-script.md](final-demo-script.md).

Live at **https://kataleai.space** (dashboard login required). Architecture:
[voice commerce](../architecture/voice-commerce.md).

## Before the demo

```bash
ssh <user>@<your-server> 'cd /opt/apps/katale-ai && docker compose ps && docker compose logs --tail=5 whatsapp'
```

Check that every service is `healthy` and WhatsApp shows `client ready`. Then:

- Sign in to the dashboard (Overview + Activity tabs open).
- Have the PayPal Sandbox **Personal** buyer ready on a second device.
- Speak clearly, close to the microphone, at most 60 seconds per voice note.

## Script (≈ 4 minutes)

| #   | Merchant does                                                                                                     | Katale AI replies                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 🎙️ _"Create an order for Sarah for ten handmade baskets at twelve dollars each and add twenty dollars shipping."_ | (if slow) _🎙️ Voice note received. I'm processing your request…_ then **Katale AI · Draft order ORD-…**: 10 × Handmade Basket @ $12.00 — $120.00 · Shipping — $20.00 · **Total — $140.00** · _Reply CONFIRM 1234…_ |
| 2   | types `CONFIRM 1234`                                                                                              | ✅ _Payment request created_ · Order · Amount $140.00 · _Pay securely with PayPal:_ link                                                                                                                           |
| 3   | buyer pays on another device                                                                                      | ✅ _Payment received_ · Order · Customer · Amount · _The order is now marked as paid._                                                                                                                             |
| 4   | 🎙️ _"How much have I sold this week?"_                                                                            | Revenue from the database                                                                                                                                                                                          |

Talking points:

- The voice note becomes text, then follows **exactly** the same path as a typed message.
- Speech is never financial truth: the backend prices the order, and the merchant approves by **typing** the code.
- Unclear speech is read back (_"I heard: …"_) instead of guessed.
- Whisper handles English; notes in other languages are read back instead of guessed.

## Languages

English is the supported voice language. Luganda work is frozen: it is off by default
(`VOICE_EXPERIMENTAL_LUGANDA=false`) and not part of the demo. A voice note in another language
is read back (_"I heard: … Is that right?"_) and nothing happens until the merchant types YES.
Earlier Luganda results are recorded in [voice commerce → Luganda results](../architecture/voice-commerce.md#luganda-results).

## If something goes wrong

| Problem                              | Do this                                                                |
| ------------------------------------ | ---------------------------------------------------------------------- |
| "I couldn't access that voice note…" | Check the worker logs; send the same request as text                   |
| "I heard: …" read-back               | Type `YES` if it's right, otherwise re-record closer to the microphone |
| WhatsApp down                        | Dashboard **Agent console** (text, same pipeline)                      |
