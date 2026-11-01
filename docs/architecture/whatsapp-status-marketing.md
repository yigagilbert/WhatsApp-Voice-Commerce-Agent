# WhatsApp Status marketing ("Status ads")

Katale can prepare daily WhatsApp Status adverts for a shop's products. **It does not publish
them automatically.** The merchant downloads the generated image, copies the caption and posts it
from their own phone. This page explains why, and how the feature works.

Assessed on 2026-11-01 against the `whatsapp-web.js` we ship (1.34.7, with our patch in
`patches/`).

## 1. Feasibility

### 1.1 Can whatsapp-web.js post a Status?

Partly, through an undocumented path.

| Evidence                                                                                                                                                                         | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Client.sendMessage(chatId, …)` in `src/Client.js`                                                                                                                               | A chat ID matching `@broadcast` (that is, `status@broadcast`) is treated as a Status. Text, image, GIF, audio and video are accepted. Documents, stickers, view-once, polls, locations, contacts and quoted replies are refused.                                                                                                                                                                                                                                      |
| `window.WWebJS.sendMessage` in `src/util/Injected/Utils.js`                                                                                                                      | Status posts call WhatsApp Web's internal `WAWebSendStatusMsgAction.sendStatusTextMsgAction({ color, font, text })` or `sendStatusMediaMsgAction(msg, mediaUpdate)`. The `caption` option applies to media. Text statuses take `extra: { backgroundColor, fontStyle }`.                                                                                                                                                                                               |
| README "Supported features" table                                                                                                                                                | Posting a Status is **not listed** as a supported feature. "Set user status message" refers to the profile _About_ text.                                                                                                                                                                                                                                                                                                                                              |
| Upstream issue [wwebjs/whatsapp-web.js#201807](https://github.com/wwebjs/whatsapp-web.js/issues/201807) (July 2026, reported on **1.34.7**)                                      | **Image and video Status posts crash** on current WhatsApp Web with `Cannot read properties of undefined (reading 'id')`. WhatsApp Web changed `sendStatusMediaMsgAction` to take a single `{ mediaMsgData, beforeSend, funnelContext }` object and to require LID identities. `WAWebStatusGatingUtils.canCheckStatusRankingPosterGating`, which our code path calls, is gone from some builds. Text statuses still worked. The issue was closed as stale, not fixed. |
| Upstream PR [#201816](https://github.com/wwebjs/whatsapp-web.js/pull/201816) "fix: Send image/video status"                                                                      | Still **open and unmerged**. It patches the injected code to call WhatsApp Web's new internal signature. No release contains it (latest release: 1.34.7, April 2026).                                                                                                                                                                                                                                                                                                 |
| Other libraries ([OpenWA v0.10.9](https://newreleases.io/project/github/rmyndharis/OpenWA/release/v0.10.9), [wa-js #1035](https://github.com/wppconnect-team/wa-js/issues/1035)) | They report Status posts that were **silently dropped** or never finished loading for viewers. In these cases the library reported success but nobody saw the post.                                                                                                                                                                                                                                                                                                   |

Formats with the shipped library on today's WhatsApp Web:

- Text Status (background colour plus font): works according to upstream reports.
- Image or video with a caption: **broken** in 1.34.7.
- Links: plain text only. Link previews are not built for Status.

Fixing images would mean copying the unmerged PR into our patch. That ties us to minified internal
WhatsApp Web modules, which changed signature twice in 2026. The next WhatsApp Web rollout could
break the fix again. In the reported failures, posts were either rejected with an error or reported
as sent while nobody saw them, so a broken release would not reliably raise an alert.

### 1.2 Who sees a Status?

- [WhatsApp Help: privacy settings](https://faq.whatsapp.com/en/android/23225461) says audience is
  set on the phone under Settings › Privacy › Status: _My contacts_, _My contacts except…_ or
  _Only share with…_. A linked device such as whatsapp-web.js cannot change it.
- **The poster's address book decides.** Under _My contacts_, only numbers saved in the shop
  phone's address book receive the Status. A customer who saved the shop's number does **not** see
  it unless the shop also saved theirs. WhatsApp's 2026 rollout of "recently messaged" audiences
  ([WABetaInfo](https://wabetainfo.com/whatsapp-is-rolling-out-a-feature-to-share-status-updates-with-unsaved-phone-numbers/))
  still requires _the poster_ to have saved the viewer.
- So the feature's premise ("customers who saved the shop number see it") does not hold on its
  own. The only way to automate reach would be to add every customer to the shop phone's contacts
  (`saveOrEditAddressbookContact` exists in 1.34.7). That changes the merchant's phone without each
  customer's knowledge or consent. We do not do it.
- No API reports Status viewers for a linked device. We could not confirm delivery automatically
  anyway.

### 1.3 Policy, ban risk and limits

- whatsapp-web.js is an unofficial client. Automated use of a personal or Business-app account is
  against WhatsApp's terms, and accounts get restricted. Katale already accepts this risk for
  replies to customers who message the shop. Broadcast **marketing** is different: it is what
  WhatsApp's spam systems look for, and the merchant's only sales number would be at stake.
- WhatsApp publishes no Status rate limit. We would have to guess the limit and could only find
  out by having the account restricted.

### 1.4 Official WhatsApp Cloud API

The Cloud API has no endpoint for posting Status updates. Meta's coexistence onboarding table lists
"Business tools (for example, catalog, orders, status)" as **not supported** for numbers on the
Cloud API ([Meta: onboarding Business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/)).
Third-party "Status APIs" such as Whapi.Cloud run unofficial web sessions underneath, so they carry
the same risks.

### 1.5 Open-source approaches

| Project                                                         | Approach                                                       | Reusable safely?                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| whatsapp-web.js PR #201816                                      | Patches injected code to WhatsApp Web's new internal signature | No: unmerged, internal API, breaks on WhatsApp Web updates                                                                             |
| wppconnect `wa-js` `status.sendImageStatus`                     | The same internal modules, maintained by another team          | Same risk; would mean a second WhatsApp Web injection framework                                                                        |
| Baileys `sendMessage('status@broadcast', …, { statusJidList })` | Reverse-engineered protocol; the caller lists the recipients   | Needs the customer list as recipients, which is effectively a broadcast to customers who didn't opt in. Different library and session. |

### 1.6 Verdict

**Automated publishing is unsupported and too risky for merchant accounts.** Image Status posts
are broken in the version we ship. The only fix depends on internal APIs, visibility depends on an
address book we must not edit, failures can be silent, and the ban risk falls on the shop's sales
number. Following the brief, we built the alternative: the agent writes Status adverts and renders
the images, and the merchant posts them from their phone, where WhatsApp's own app handles privacy
and audience.

No status was posted during this work, from any number. A real-phone test needs the owner's linked
test phone and is not needed for the manual design.

## 2. Architecture

```
 Dashboard (Next.js /status)
   │ server actions, with the dashboard session
   ▼
 API /api/status-ads/*  ──►  StatusAdService ──► CustomerCatalog rules (visible, active, in stock)
   │  owner/staff, merchant-scoped           ├─► ProductImageService.read (R2 or Postgres)
   │  404 while STATUS_ADS_ENABLED=false     ├─► ChatModel (optional, copy only, validated)
   ▼                                         └─► status-image.ts (SVG + resvg + sharp → 1080×1920 JPEG)
 ReportScheduler tick (1 min) ──► job "status-ads" ──► StatusAdService.tick(now)
```

- **Module**: `apps/api/src/modules/status-ads/`. Nothing in it can send a WhatsApp message. It
  does not import the notification service or the gateway, and an integration test checks that no
  message goes out.
- **Data**: `StatusAdSettings` (one row per merchant) and `StatusAd` (one row per generated
  advert). `@@unique([merchantId, slotKey])` makes each scheduled slot idempotent across overlapping
  ticks, restarts or a second instance, the same as report runs.
- **Scheduling**: a job on the existing report scheduler tick. For each enabled merchant it
  computes the latest slot for every preferred time on the enabled weekdays (reusing `latestSlot`).
  A slot is generated at most once, and only within 3 hours of its time, so a long outage doesn't
  release a backlog.
- **Generation**:
  1. Pick a product. Candidates are the products chosen in settings (or all), filtered to
     active, visible to customers, in stock (untracked stock counts as available) and with a
     photo. Least recently featured comes first, so content rotates. A product is never repeated
     within a day while others are eligible.
  2. Write the copy. The AI gets only the product name and the merchant's description, plus recent
     headlines to avoid. It returns a short headline and a caption in English. A guard rejects any
     digit, currency sign or percentage, any discount, offer or price word, superlatives and health
     or guarantee claims, non-Latin script, and anything too long. If the AI copy is rejected, the
     AI is not configured, or it fails, varied built-in templates are used instead.
  3. Pick the call to action from a fixed list (message us, reply to this status, browse, order),
     rotated.
  4. Choose a colour theme, rotated.
- **Image**: rendered on request from the live product photo, name and **catalogue price**, so the
  price is never AI text and never stale. Before rendering or approving, the product's eligibility
  is checked again. An advert whose product went out of stock or was hidden can't be approved,
  downloaded or marked posted.
- **Approval**: _Manual_ mode creates drafts that an admin edits and approves. _Auto-ready_ mode
  creates adverts that are ready to post straight away. In both modes **a person posts them**.
  Afterwards the admin marks the advert _Posted_ (or _Skipped_) for the history.
- **Failures**: no eligible product, or a photo that can't be read, gives `FAILED` with the
  reason. Failures retry automatically after 5 and 30 minutes, then can be retried from the
  dashboard.
- **Limits**: at most 3 preferred times per day. Manual "Generate now" is limited to 20 per
  merchant per day and has a per-route request limit. Images are rendered on request (about 100 ms)
  and are not stored.
- **Access**: every query is scoped to the signed-in account's merchant. Owners change settings.
  Owners and staff generate, edit, approve and record posts. Actions are written to the audit log
  (`status_ad.*`).
- **Feature flag**: `STATUS_ADS_ENABLED` (default `false`). While it is off, the routes return 404,
  the scheduler job is not registered and the dashboard explains that the feature is off. Each
  merchant also has its own on/off switch, which defaults to off.

## 3. Configuration and deployment

1. Deploy the release with the new migration (`pnpm db:deploy` runs as usual in the API
   container).
2. Set `STATUS_ADS_ENABLED=true` in the API environment and restart the API. The web app needs no
   new variable.
3. In the dashboard, open **Status ads**, choose days, times, time zone, products and approval
   mode, and turn the shop's switch on.
4. Optional: with `AI_API_KEY` set, the copy is AI-written and checked by the guard. Without it,
   the built-in templates are used.

## 4. Future work

- **Engagement**: a "Status ad" tag on orders from customers who reply to a Status. WhatsApp
  delivers Status replies as normal messages that quote the Status, so the worker could detect the
  quote and attribute the chat. A per-advert view count typed in by the merchant, who can see
  viewers on the phone.
- Re-assess automated publishing if WhatsApp offers an official Status API, or if whatsapp-web.js
  releases a fix that stays stable across several WhatsApp Web updates. That would still need a
  test from the owner's linked test phone, and a visibility check from a second phone that has
  saved the shop number.
- Short product videos for Status, and more layouts.
