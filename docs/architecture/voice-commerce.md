# Voice commerce

> **Status (2026-10-07): English is the supported voice language.** Luganda and other local
> languages are **frozen** (experimental): the Sunbird AI cascade, the Luganda number normaliser and
> glossary stay in the code but are **off by default** (`VOICE_EXPERIMENTAL_LUGANDA=false`). With the
> flag off, a voice note Whisper hears as any language other than English is read back
> (_"I heard: … Is that right?"_) and only a typed YES continues. Local-language ASR will be revisited
> with stronger models and a dedicated evaluation.

Merchants can send WhatsApp **voice notes** instead of typing. Voice is only another input
modality: once speech becomes text it enters the **same inbound commerce pipeline** as typed
messages (agent → tools → backend pricing → confirmation → PayPal). The LLM, tools, confirmation
logic, PayPal service and database don't know whether a request was spoken.

## Flow

```mermaid
flowchart TD
  WA[WhatsApp voice note<br/>Ogg/Opus] --> W[WhatsApp worker<br/>downloadMedia + duration hint]
  W -->|POST /api/agent/message<br/>type=audio, base64| IN[Inbound pipeline]
  W -. after 2.5 s .-> ACK["🎙️ Voice note received. I'm processing…"]
  IN --> V[decodeAudioMedia<br/>MIME allow-list · size · OggS magic]
  V --> D{duration ≤ 60 s?<br/>Ogg granule / hint}
  D -- no --> TOO[too-long reply · no STT]
  D -- yes --> P[Whisper primary]
  P -->|heard English| T[transcript + language + confidence]
  P -->|heard another language / nothing| S[Sunbird ASR · lug]
  S --> T
  T --> C{confidence ≥ 0.5?}
  C -- no --> RB["I heard: … Is that right? (typed YES continues)"]
  C -- yes --> TR{translate this language?}
  TR -->|VOICE_TRANSLATE_LANGUAGES| X[Sunbird translate → English]
  TR -->|default| AG
  X --> AG[Same commerce agent + tools as text]
  AG --> SUM[Backend-generated draft · CONFIRM code]
```

## Components

| Concern         | Where                                        | Notes                                                                                                                                               |
| --------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Download        | `apps/whatsapp` (`downloadMedia`)            | Base64 to the API; pre-checks size and WhatsApp's own duration; errors → _"I couldn't access that voice note…"_                                     |
| Acknowledgement | worker                                       | Sent once, only if the API hasn't answered within 2.5 s                                                                                             |
| Validation      | `decodeAudioMedia`                           | MIME allow-list (ogg/opus, mpeg, mp4, aac, m4a, wav, webm), size limit before decode, strict base64, Ogg magic bytes; in memory only, no temp files |
| Duration        | `oggOpusDurationSeconds`                     | Read from the Ogg container (last granule − pre-skip, 48 kHz). No ffmpeg; enforced **before** any STT call                                          |
| English ASR     | `OpenAICompatibleSpeechToText` (`whisper-1`) | `verbose_json` → text, language, segment log-probs → confidence 0..1                                                                                |
| Luganda ASR     | `SunbirdSpeechToText`                        | `POST /tasks/audio/transcriptions`, `language=lug`; accepts Ogg/Opus directly                                                                       |
| Routing         | `CascadeSpeechToText`                        | Only with `VOICE_EXPERIMENTAL_LUGANDA=true`: Whisper first; if it heard English → done; otherwise Sunbird `lug`                                     |
| Translation     | `SunbirdTranslator` (optional)               | Only for languages in `VOICE_TRANSLATE_LANGUAGES`                                                                                                   |
| Pipeline        | `SpeechPipeline`                             | Keeps `transcript` (original) and `normalizedText` (what the agent sees) separate; reports `audioSeconds`, `sttMs`, `totalMs`                       |
| Integration     | `InboundMessageService`                      | Stores transcript/language on the `Message`; audits `speech.transcribed` and `voice.processed` (latency, outcome)                                   |

### Why these choices

- **Whisper for English.** It was already configured and is fast (0.8–1.8 s for 2–5 s clips). It
  reports language and per-segment log-probabilities, which give a confidence score. Sunbird's
  English output dropped a word in testing.
- **Whisper-first cascade instead of audio language ID.** Sunbird's audio language-ID endpoint took
  8–9 s and returned `unknown` for clear English, and its text language ID labelled English as `pcm`.
  Whisper can't transcribe Luganda, but it reliably labels it as _some other language_, which is
  exactly the signal used to switch to Sunbird. English costs one call; Luganda costs two.
- **No audio conversion.** Both engines accept WhatsApp's Ogg/Opus natively. `AUDIO_NORMALIZER=ffmpeg`
  remains available but off, so the API image needs no ffmpeg.
- **No temp files.** Audio is decoded and streamed from memory; nothing is written to disk or served.

## Safety rules

- **Fail safe:** any download, validation, duration or STT failure replies politely and stops. No tools
  run, so no draft, confirmation or PayPal request can be created (integration-tested).
- **Low confidence:** below `VOICE_MIN_CONFIDENCE` (0.5) Katale AI reads the transcript back
  (_"I heard: …"_). Only a **typed** YES continues; NO or any other message discards it.
- **No spoken approvals:** a transcribed "yes" or "confirm 1234" never claims a payment confirmation;
  the merchant is asked to type `CONFIRM <code>`. Financial approval stays deterministic and text-only.
- **Voice-aware prompt:** the agent is told the request was transcribed and must ask rather than guess
  unclear quantities, prices, products or customers.
- Speech is never financial truth: amounts still come from catalog lookups and backend arithmetic,
  limits and price-override warnings still apply, and payment still needs the CONFIRM code.

## Languages

| Language       | Detection                 | ASR                                                                   | Into the agent                          |
| -------------- | ------------------------- | --------------------------------------------------------------------- | --------------------------------------- |
| English (`en`) | Whisper                   | Whisper                                                               | transcript as-is                        |
| Luganda (`lg`) | "not English" per Whisper | Sunbird `lug`                                                         | see [Luganda results](#luganda-results) |
| Other          | —                         | Sunbird `lug` attempt; unintelligible → "couldn't make out any words" | —                                       |

`Message.transcription` keeps the original transcript, `Message.normalizedText` what the agent saw,
and `Message.detectedLanguage` the language. The audit event `speech.transcribed` records provider,
confidence, audio length and STT latency.

## Configuration

| Variable                                                      | Default                                        | Purpose                                               |
| ------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| `VOICE_NOTES_ENABLED`                                         | `false`                                        | Worker downloads and API transcribes only when `true` |
| `VOICE_MAX_DURATION_SECONDS`                                  | `60`                                           | Longest voice note (worker pre-check + API check)     |
| `VOICE_MIN_CONFIDENCE`                                        | `0.5`                                          | Read-back threshold                                   |
| `STT_PROVIDER` / `STT_BASE_URL` / `STT_API_KEY` / `STT_MODEL` | `openai-compatible` / OpenAI / — / `whisper-1` | English ASR                                           |
| `VOICE_EXPERIMENTAL_LUGANDA`                                  | `false`                                        | Experimental Luganda cascade (frozen)                 |
| `SUNBIRD_API_URL` / `SUNBIRD_API_KEY`                         | `https://api.sunbird.ai` / —                   | Sunbird credentials for the experiment                |
| `TRANSLATION_PROVIDER` / `VOICE_TRANSLATE_LANGUAGES`          | `none` / `""`                                  | Optional translate-first for listed languages         |

## English results (real providers)

`pnpm test:voice:external` on the synthetic evaluation clips (`tests/evaluation/voice-commerce.json`):

| Clip             | Transcript | Conf. | Audio | STT   | Voice → decision | Action                                          |
| ---------------- | ---------- | ----- | ----- | ----- | ---------------- | ----------------------------------------------- |
| en-order-001     | exact      | 0.78  | 5.3 s | 1.7 s | 3.1 s            | `create_draft_order` 10 @ $12, $20 shipping     |
| en-clarify-002   | exact      | 0.62  | 2.3 s | 1.8 s | 2.7 s            | asks how many                                   |
| en-highprice-003 | exact      | 0.76  | 4.0 s | 0.8 s | 4.0 s            | draft 20 @ $1,000 → backend refuses (> $10,000) |
| en-cancel-004    | exact      | 0.63  | 1.5 s | 1.0 s | 2.0 s            | explains cancellation isn't supported           |
| en-sales-005     | exact      | 0.68  | 1.8 s | 1.8 s | 4.0 s            | `get_sales_summary(this_week)`                  |

## Luganda results

Real Luganda voice notes from the merchant WhatsApp account, in production (2026-10-06). Details are in
`tests/evaluation/voice-commerce.json` (reference transcripts and observations only; no recordings committed).

| Utterance (meaning)                              | Sunbird transcript                                                                                              | Audio  | STT           | Agent                | Result                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------ | ------------- | -------------------- | ------------------------------------------------------------------------------- |
| stock question                                   | _Odda ki ze tulina mu sitooku essaawa zino?_                                                                    | 3.7 s  | 17.8 s (cold) | `check_inventory`    | partial: history drift; in isolation `list_products`, answered in Luganda (3/3) |
| order: Sarah, 10 baskets, $12 each, $20 shipping | _Kola HB order eya ssaala ayagala HB kkumi buli emu ku dollar kkumi na bbiri … Shipping price ya dollar abiri._ | 12.7 s | 4.1 s         | `create_draft_order` | **shipping $2 instead of $20** → fixed (below)                                  |
| spoken "Confirm 2720"                            | _Confirm 2720._ (Whisper, en)                                                                                   | 4.0 s  | 0.6 s         | —                    | refused: type CONFIRM ✔                                                         |
| 5 coffee gift packs for James (code-switched)    | _5 odas for jams 5 koffi gifts gistpaks for jams._                                                              | 10.3 s | 2.8 s         | clarification        | safe, no draft ✔                                                                |
| follow-up in English                             | _Yes, I want five coffee gifts … customer is called James._                                                     | 9.4 s  | 9.7 s         | lookups, asked again | partial                                                                         |

**Routing worked as designed.** Every Luganda note was labelled non-English by Whisper and transcribed
by Sunbird (`lg`); the spoken confirmation was English (Whisper) and refused.

### Choosing the Luganda route (evidence)

The same real transcript, three runs per variant with the real LLM:

| Variant                                           | Outcome                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| Luganda → LLM directly                            | no draft; "Kola" (= make) taken as a customer name (3/3)           |
| + numeral glossary in the prompt                  | draft 10 × $12, but shipping **$2** (3/3)                          |
| Translate first (Sunbird → English)               | translation invented "shoes"/"pairs"; agent asked to clarify (3/3) |
| **Directly + deterministic number normalisation** | draft **10 × $12, shipping $20** (3/3) ← **chosen**                |

`normalizeLugandaNumbers` (`packages/speech`) turns number words into digits in code before the agent sees
the text: "kkumi na bbiri" → 12, "dollar abiri" → 20, "amakumi abiri mu ttaano" → 25. The original
transcript is kept in `Message.transcription`; the normalised text is in `Message.normalizedText`.
Translation stays available (`VOICE_TRANSLATE_LANGUAGES=lg`) but is off: in testing it invented content.
The prompt also gets a short Luganda glossary (number words, _kola_ = make, _buli emu_ = each).
The vocabulary is a starter list to validate with native speakers.

### Safeguards added from the Luganda tests (they apply to text too)

- **Voice never silently creates a customer.** A misheard name ("ssaala") returns
  _"No customer named 'ssaala'. Did you mean Sarah Thompson?"_, and the agent asks.
- **Non-catalog items are flagged** in the backend summary (_"'buckets' isn't in your catalog (closest:
  Handmade Basket) — priced as stated"_), and unknown products without a price get a closest-match suggestion.

### Known Luganda limitations

- Sunbird latency varies: 2.8–9.7 s warm, about 18 s on a cold start; voice-to-reply was 4–21 s.
- Code-switched speech (Luganda with English product names) transcribes inconsistently; the agent asks.
- Conversation history can pull follow-ups toward earlier topics (seen with "jams").
- English with a strong accent is sometimes routed to Sunbird. Sunbird still transcribed English well.
