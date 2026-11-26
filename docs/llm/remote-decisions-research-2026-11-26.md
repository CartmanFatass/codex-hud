# Remote owner decisions: open-source survey (2026-11-26)

Research only; parked by the owner (nothing built, no spec change). Source: oracle job jc101d434509e9be0 with three
web scouts. Goal: push an owner-reserved decision (recommendation + 2-4 choices, optional free text) to a phone or
watch, self-hosted, and record the single answer; no answer = only that item waits, one reminder, never auto-decide.

## Platform limits that decide the design

- iPhone and Apple Watch action buttons need a native iOS app that registers `UNNotificationCategory`; native APNs
  push needs a paid Apple Developer Program key. A watchOS app is optional (the Watch mirrors the iPhone app's
  actions). Sources: developer.apple.com (actionable notification types, APNs token connection, app capabilities).
- Web Push on iOS 16.4+ works only for Home-Screen web apps, needs no Apple account, and carries end-to-end
  encrypted payloads (RFC 8030/8291/8292), but iOS does not support `Notification.actions`: the Watch shows the
  prompt read-only and answering takes two taps on the iPhone. Sources: webkit.org Web Push posts, MDN
  `Notification.actions` compatibility data.
- Android: native apps get up to 3 action buttons plus inline reply, and Wear OS bridges them to the watch. Chrome
  Web Push allows 2 actions; whether those stay tappable on Wear OS is unverified.
- From WSL2, `tailscale serve` gives an HTTPS tailnet-only origin for a loopback listener.

## Candidates (short)

| Option | Licence | Fit |
|---|---|---|
| HUD-built PWA + Web Push (no new deps) | repo licence | Best overall: self-hosted, no relay of plaintext, phone detail page with all choices and free text; Watch alert only on iOS |
| ntfy (server + apps) | Apache-2.0/GPL-2.0 server, MIT iOS, Apache-2.0 Android | Use directly as an add-on: 1-tap answers on Wear OS (≤ 3 choices via `http` actions); no Watch buttons on iOS |
| Home Assistant Companion | Apache-2.0 | Watch buttons and dictation on both platforms without an Apple account, but a heavy stack unless already run |
| Matrix + bot (Element X) | AGPL-3.0 / Apache-2.0 | Text/voice reply only, no choice buttons on watches |
| Happy (coding-agent mobile client) | MIT | Good approval-card UX to borrow; needs Postgres/relay stack; no watch target |
| Telegram bridges | MIT | Rejected: Telegram servers hold plaintext |
| Gotify, Bark, UnifiedPush, Apprise, VibeTunnel, Omnara | various | No multi-choice actions, single platform, transport only, or unclear status |

## Recommendation recorded for later

1. Build a small HUD decision page + Web Push inside the unattended service, loopback-bound and exposed with
   `tailscale serve`; borrow Happy's approval-card UX. Answers go through the existing write-once paths (queue
   hand-back answer, unattended hold resolution, `hud_objective` request resolve).
2. Add self-hosted ntfy only if the owner uses Android + Wear OS and wants wrist taps.
3. Security minimum: device pairing token (0600, hashed), POST-only answers bound to the live decision revision
   (replays and stale taps refused with the recorded outcome), clear the phone banner when answered at the desk.
4. Spec impact if built: a narrow §3 carve-out from "cross-machine control is a later TODO" and a §4 sentence on the
   loopback listener, device auth and revision-bound answers.

Owner answers so far (2026-11-26): Android phone. The phone side may be richer, including more complex remote
interaction; the simple form (recommendation + a few one-tap choices) is for the watch. With Android + Wear OS the
survey's path is the HUD page/Web Push for the phone plus self-hosted ntfy `http` actions for 1-tap wrist answers.

Still open when reopened: watch model (Wear OS assumed), how far "more complex remote" goes on the phone (decisions
only, or also viewing runs and steering work), exposure (Tailscale recommended), reminder delay (2 h suggested), and
the spec carve-out.

## Owner-proposed alternative: a private Cloudflare Worker (free plan)

Owner asked (2026-11-26) whether a self-deployed, private Cloudflare Worker can replace Tailscale. Main session's
assessment, **not yet verified against Cloudflare docs** (verify limits before slicing):

- Shape: a Worker plus one Durable Object in the owner's own account acts as a mailbox. HUD connects outbound
  (WebSocket or polling), so WSL2 opens no inbound port and the phone needs no VPN. The phone opens the Worker's
  page or gets Web Push (VAPID signing and RFC 8291 encryption are doable with WebCrypto in the Worker); ntfy
  `http` actions on the watch call the Worker URL. Answers flow back over the same channel into HUD's existing
  write-once paths.
- Extra benefit: prompts and answers queue in the Durable Object while the PC sleeps; they apply when HUD reconnects.
- Free-plan points to verify: daily request quota (believed 100k/day), Durable Objects availability on the free plan
  (believed yes for SQLite-backed objects), per-request CPU limit (~10 ms) against Web Push encryption cost, and
  Cloudflare Access free tier for owner login.
- Privacy: TLS terminates at Cloudflare, so content is visible to Cloudflare unless HUD encrypts end to end.
  Recommended if chosen: HUD encrypts each prompt with a key shared with the phone once at pairing (QR), the Worker
  stores and forwards ciphertext only, the phone page decrypts; Cloudflare Access plus a HUD device token guard
  the page.
