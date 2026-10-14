# Architecture Decision Records

Short records of decisions that shape the codebase. Add a new numbered file when a decision
is made or reversed; never rewrite history — supersede instead.

| #                                                     | Decision                                                   | Status   |
| ----------------------------------------------------- | ---------------------------------------------------------- | -------- |
| [0001](0001-modular-monolith.md)                      | Start as a modular monolith with separately runnable apps  | Accepted |
| [0002](0002-whatsapp-behind-adapter.md)               | Isolate `whatsapp-web.js` behind a channel adapter/process | Accepted |
| [0003](0003-confirmation-before-financial-actions.md) | Financial actions require explicit, bound confirmation     | Accepted |
| [0004](0004-backend-calculates-money.md)              | Backend calculations override any LLM-produced amounts     | Accepted |
| [0005](0005-provider-abstractions.md)                 | Abstract AI, speech, channel and payment providers         | Accepted |
| [0006](0006-integer-minor-units.md)                   | Store money as integer minor units                         | Accepted |
| [0007](0007-capture-on-return-and-webhook.md)         | Capture on buyer return; webhook as fallback               | Accepted |
