# 0005 — Abstract AI, speech, channel and payment providers

**Status:** Accepted · 2026-10-05

## Context

The best LLM/ASR for English is not the best for Luganda; provider pricing and availability change;
hackathon credits differ by sponsor. Tests must run without network access.

## Decision

Small interfaces, one composition root (`apps/api/src/container.ts`):

| Concern          | Interface                              | First implementation                  |
| ---------------- | -------------------------------------- | ------------------------------------- |
| LLM              | `ChatModel` (`@vca/ai`)                | `OpenAICompatibleChatModel` (fetch)   |
| ASR              | `SpeechToTextProvider` (`@vca/speech`) | `OpenAICompatibleSpeechToText`        |
| Language ID      | `LanguageDetectionProvider`            | none yet (ASR-reported language used) |
| Translation      | `TranslationProvider`                  | none yet                              |
| Audio            | `AudioNormalizer`                      | `FfmpegAudioNormalizer`               |
| Payments         | `PayPalApi` (`@vca/paypal`)            | `PayPalClient` (fetch)                |
| Outbound channel | `ChannelSender` (`@vca/shared`)        | `HttpWhatsAppSender`                  |

Implementations use `fetch` instead of vendor SDKs to keep dependencies small and behaviour explicit.

## Consequences

- Adding Anthropic, Gemini, Sunbird AI or a local model is one class + one line in the container.
- Tests inject fakes (`tests/support/fakes.ts`) — the full demo flow runs offline.
- We lose some SDK conveniences (automatic retries, streaming helpers); add them when needed.
