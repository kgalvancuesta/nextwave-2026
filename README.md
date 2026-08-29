# Marketline telephony milestone

Marketline is a small Next.js dashboard for proving the PSTN substrate of a future carrier-market voice agent. It stores an editable carrier phonebook, starts up to three real Twilio calls concurrently, receives inbound Twilio calls, polls live status, and preserves call/recording history in SQLite.

There is no AI, speech recognition, negotiation, mandate, commitment, or OpenAI integration in this milestone. Answered calls play an explicit placeholder TwiML message.

## Architecture

```text
Dashboard -> Next.js route handlers -> Call service -> TelephonyProvider
                                      |                 |
                                      |                 +-- TwilioTelephonyProvider
                                      |
                                      +-- SQLite repository

Twilio webhooks -> signature validation -> call persistence
                                      |
                                      +-- VoiceSessionAdapter
                                             +-- PlaceholderVoiceSessionAdapter
```

The future realtime agent belongs in a new `VoiceSessionAdapter` implementation. Contact storage, batch creation, Twilio status handling, call history, and the dashboard do not need to change.

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

## 5. First live test

1. Add three contacts in Marketline. Mexican national-format numbers use `MX` as the default region; international numbers should include `+` and country code.
2. Edit any saved entry to verify the normalized E.164 number updates persistently.
3. Select three contacts and press **Call selected (3)**.
4. Verify three independent Twilio Call SIDs are created and each card changes through initiated, ringing, and in progress independently.
5. Answer a call and confirm the placeholder says the voice agent is not connected.
6. Call the Twilio number from a real phone. Confirm the inbound placeholder and the inbound record in Marketline.
7. Hang up and confirm the call moves from Active Calls to Recent Calls.

The three Twilio REST requests use `Promise.allSettled`; one rejected destination does not stop the others.

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
