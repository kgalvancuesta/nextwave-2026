# Marketline order + market state

Marketline is an operational Next.js dashboard for ground-transport procurement. It manages persistent orders, mandate snapshots, carrier markets, historical offers, commitments, recovery markets, and the existing Twilio phone system in one authoritative SQLite state.

On top of that substrate runs the Volta voice layer: an OpenAI Realtime agent that phones carriers, records progressive offer facts, and is bounded by deterministic policy rather than by its prompt. Calls launched from an order write immutable offer versions into that order's authoritative market and receive fresh instructions whenever the whole-market evaluator changes its decision. The standalone recovery APIs still keep their existing state in `volta_*` tables. Without `OPENAI_API_KEY`, answered calls play the placeholder TwiML message.

## Architecture

```text
Human dashboard ─┐
Voice agents ────┼─> OrderMarketService ─> normalized SQLite state
                 │        │
Twilio webhooks ─┘        └─> whole-market feasibility, Pareto ranking, and actions

Market call action -> existing Call service -> TwilioTelephonyProvider -> PSTN

Twilio webhooks -> signature validation -> call persistence
                                      |
                                      +-- VoiceSessionAdapter
                                             +-- PlaceholderVoiceSessionAdapter
                                             +-- SipBridgeVoiceSessionAdapter
                                                    |
                                                    v
                                             OpenAI Realtime (SIP)
                                                    |
                                             Volta agent + deterministic market policy
```

Orders and markets are separate records. Every market preserves its mandate snapshot, and every progressive offer update creates an immutable version linked to the version it supersedes. Calls link to order, market, and carrier. A partial unique index prevents two active commitments for the same market. The dashboard and voice agents consume the same derived `getMarketState` result.

The realtime agent is connected through `VoiceSessionAdapter`. Contact storage, concurrent batch creation, Twilio status handling, call history, and the existing SIP bridge are reused.

## The Volta voice layer

```text
lib/volta/
  models.ts / mandate.ts / carriers.ts   the mandate and its deterministic checks
  ports.ts                               the interfaces the policy depends on
  store.ts                               negotiation state in the volta_* tables
  voice-control-service.ts               every decision the agent is not allowed to make
  gateways.ts / sip.ts / service.ts      Twilio dialling, SIP correlation, wiring
  agent/                                 the OpenAI Agents SDK agent
  openai-agents-runtime.ts               RealtimeSession lifecycle and audit trail
```

How a voice recovery runs:

1. `POST /api/operations` records the mandate the agent must stay inside: price
   ceiling, pickup window, prohibited terms, detention cap.
2. `POST /api/operations/:id/carrier-markets` dials at least three distinct
   carriers concurrently. They are ordinary rows in `calls`, so the dashboard,
   the status callbacks and the recordings apply to them unchanged.
3. Twilio answers and fetches the answer TwiML, which bridges the leg into
   OpenAI Realtime over SIP. The call and operation IDs travel as SIP headers
   issued by the server, never by the model.
4. `POST /api/webhooks/openai` accepts the Realtime call, briefs the agent from
   server state and attaches the sideband session.
5. The agent records each quote through `record_carrier_quote`. Eligible and
   rejected offers are both stored with their mandate verdict and audio evidence.
6. `POST /api/carrier-markets/:id/select-best` picks the winner
   deterministically: mandate-valid first, then lower rate, earlier pickup,
   higher reliability.
7. `POST /api/carrier-markets/:id/confirm` calls the winner back to read the
   exact terms. Only there can the agent reach `propose_commitment`.
8. `POST /api/calls/:id/complete` sends the SMS recap, which is what turns a
   `proposed` commitment into an `effective` one.

Invariants worth knowing before changing this code:

- The model proposes; deterministic code approves against the mandate.
- The tool surface is the policy boundary, not the prompt. A quote call cannot
  reach `propose_commitment` at all, and an unidentified inbound call cannot
  reach any commercial tool. A live call is re-briefed only when server state
  grants it a wider surface.
- A commitment stays `proposed` until the written recap is delivered.
- A market winner must be selected before any market call may commit, and the
  final terms must match the selected quote exactly.
- Uncorrelated legs are never bridged to the agent.

The standalone `/api/operations` recovery workflow above remains available.
Order-launched procurement calls use a narrower tool surface: they cannot call
`propose_commitment`; they write progressive facts into `OrderMarketService`,
and only its transactional award gate can create the dashboard commitment.

## What makes an award auditable

An award is a claim about what a carrier agreed to. Two mechanisms make that
claim checkable rather than trusted.

**The written recap.** The award transaction freezes an SMS body next to the
commitment, built only from persisted server state — never from model output —
so the message the carrier receives is exactly the commitment the dashboard
holds. Delivery is a separate retryable step (`flushAwardRecaps`), which means a
Twilio outage delays the written record without ever rolling back a booking the
carrier already accepted verbally. A recap that fails three times is marked
`FAILED` and surfaces in the commitment panel instead of disappearing. The
winning carrier also hears the same terms read back before the call ends: the
award payload travels in the tool result that closed the market, and the agent
must confirm the terms and name the booking ID rather than re-negotiate.

**The audio evidence.** Every progressive offer version stores the carrier's
verbatim statement, the Realtime conversation item it came from, and the offset
into the call recording where it was said. The offset is measured by the server
from the call clock — the recording's own start time once Twilio reports it,
the answered leg before that — so a model cannot move a fact to a different
moment of the audio. The dashboard plays that moment through
`/api/offers/:id/audio`, which streams Twilio media using the account
credentials; the raw provider URL never reaches the browser, and the route sits
behind the same basic-auth proxy as the rest of the dashboard. Set
`RECORD_CALLS=true` before the call to capture the audio; without it the
statement and offset are still recorded, but there is nothing to play.

## Decision log

Every significant design decision, the alternative we rejected, and why, is in
[DECISIONS.md](./DECISIONS.md) — including the limitations we know about.

## 1. Install and initialize

Requirements: Node.js 22 or newer, npm, a Twilio account, a voice-capable Twilio phone number, and ngrok or another HTTPS tunnel.

```bash
npm install
cp .env.example .env.local
mkdir -p secrets
cp docs/twilio-credentials.example.md secrets/twilio.md
npm run db:migrate
```

Put the real Twilio values in `secrets/twilio.md` using the exact documented key names. `secrets/` is gitignored. Environment variables remain supported and override the file. REST calls can authenticate with either `TWILIO_AUTH_TOKEN` or the `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` pair. Twilio webhook signature validation still requires `TWILIO_AUTH_TOKEN`; API keys cannot validate webhook signatures.

For live Realtime calls, also set `OPENAI_API_KEY`, `OPENAI_PROJECT_ID`,
`OPENAI_WEBHOOK_SECRET`, and `OPENAI_SIP_URI`. The SIP URI is derived from the
project ID when omitted. `HUMAN_ESCALATION_URI` is optional: set it and an
escalation hands the live leg to that number; leave it unset, or let the transfer
fail, and the escalation is still recorded, the lane is still paused, and the
agent promises a callback and ends the call. A counterparty is never left on an
open line with an agent that has no authority left.

Start the app:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## 2. Expose the app

In another terminal:

```bash
ngrok http 3000
```

Copy the generated HTTPS origin, for example `https://abc123.ngrok.app`, into `.env.local`:

```text
PUBLIC_BASE_URL=https://abc123.ngrok.app
```

Set a strong `DASHBOARD_PASSWORD` if you will open Marketline through that public URL. Without one, the dashboard and call-control APIs work on localhost but reject public-tunnel access; Twilio webhook routes remain reachable and signature-protected. Restart `npm run dev` after changing `.env.local`.

Do not use localhost in `PUBLIC_BASE_URL`; Twilio must reach the application over public HTTPS.

## 3. Configure the Twilio number

In Twilio Console:

1. Open **Phone Numbers → Manage → Active numbers**.
2. Select the phone number stored as `TWILIO_PHONE_NUMBER`.
3. Under **Voice Configuration**, set **Configure with** to **Webhook**.
4. Set **A call comes in** to:
   - URL: `https://YOUR-NGROK-HOST/api/twilio/voice/inbound`
   - Method: `HTTP POST`
5. Set **Call Status Changes** to:
   - URL: `https://YOUR-NGROK-HOST/api/twilio/status`
   - Method: `HTTP POST`
6. Save the number configuration.

The second webhook is essential. Without it, an inbound call cannot reliably leave the dashboard's Active Calls list after hanging up.

Outbound calls configure these callbacks automatically:

- TwiML: `/api/twilio/voice/outbound`
- Lifecycle: `/api/twilio/status`
- Recording state when enabled: `/api/twilio/recording`

Twilio signatures are validated against `PUBLIC_BASE_URL` by default. A rejected callback is logged and returns HTTP 403. `TWILIO_VALIDATE_SIGNATURES=false` exists only for development diagnosis and is rejected when `NODE_ENV=production`.

## 4. Twilio account checks

- Open **Voice → Settings → Geo Permissions** and enable every destination country needed for the demo.
- Trial accounts can call only verified recipient numbers. Verify all three test numbers or upgrade the account.
- Confirm the account has funds and the selected Twilio number has Voice capability.
- Regulations and geographic permissions can make a valid E.164 number uncallable. Marketline reports the Twilio error separately from phone-number validation.

## Demo scenario

`npm run demo:seed -- "Transportes Pacifico=+52..." "Drayage Occidente=+52..."`
creates the carriers and one at-risk order -- free time ending in 28 hours,
demurrage priced per day, a mandate with a hard ceiling, and two conditions the
carrier must confirm out loud: a named driver and a confirmed terminal
appointment. Those two are what make the evaluator enforce ground truth rather
than accept a promise: a carrier that will not confirm them cannot be awarded.

The order is left in DRAFT so the first thing that happens in front of an
audience is the button press, not data entry. Without arguments the script uses
placeholder numbers that will not ring.

## 5. Order and market test

1. Add up to three carriers. Mexican national-format numbers use `MX` as the default region; international numbers should include `+` and country code.
2. Create an order with its target, maximum, timing mandate, priority weights, required conditions, minimum feasible-offer count, and selected carriers.
3. Expand the order and press **Call carriers**. Verify all call records appear immediately in the market and global call activity.
4. Answer the carrier legs. Give one complete feasible quote, one partial quote, and one infeasible quote. Verify partial facts appear progressively and the strong carrier is held while unresolved lanes continue.
5. Complete the partial quote. Verify the evaluator requests missing fields, negotiates only eligible frontier offers, releases dominated or infeasible carriers, and awards only after the market-close policy is satisfied.
6. Confirm the winning commitment appears once and the order turns green. A late inbound better quote may be recorded, but must not revoke the closed award.
6b. Confirm the winning carrier hears the exact terms read back with the booking ID, and that the commitment panel shows the written recap as sent, with the body it sent. With `RECORD_CALLS=true`, open **Evidence** under any offer and confirm the audio starts at the moment the carrier stated that number.
7. For a recovery test, mark the committed carrier failed, create a recovery market, and repeat. The failed market and commitment remain visible.
8. Mark the transport completed. Confirm the order becomes gray and remains available under the Past filter.

The carrier Twilio REST requests use `Promise.allSettled`; one rejected destination does not stop the others. A five-minute procurement deadline prevents an unanswered lane from blocking the market forever. Deadline evaluation currently runs when the dashboard polls `/api/orders`.

The carrier directory also retains **Quick call** for direct telephony testing outside an order.

## Recording groundwork

Set `RECORD_CALLS=true` only after reviewing recording-consent requirements for every applicable jurisdiction. Marketline then:

- discloses that the call may be recorded;
- requests dual-channel Twilio recording;
- stores recording SID, call SID, status, Twilio URL, duration, and start time;
- does not download or duplicate audio locally.

## Commands

```bash
npm run dev
npm run db:migrate
npm run typecheck
npm run lint
npm test
npm run build
```

The SQLite file defaults to `data/marketline.db` and is gitignored. Migrations are additive and do not clear saved contacts or call history.
