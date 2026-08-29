# Nextwave voice operations control plane

Initial scaffold for a server-controlled freight voice agent. The service keeps policy and operation state outside the voice model, accepts OpenAI Realtime SIP calls, exposes a sideband control channel, and delegates outbound dialing and written recaps through provider-neutral HTTP adapters.

This is not production telephony yet. A telephony provider must originate outbound PSTN calls and record audio, and a recap provider must deliver SMS/email. The current interfaces make those dependencies explicit instead of simulating successful delivery

## Architecture

```text
PSTN <-> telephony/SIP provider <-> OpenAI Realtime SIP
                                      | sideband WebSocket
                                      v
                               this control plane
                        mandate | tools | state | audit
                              /                 \
                  outbound dialer webhook    recap webhook
```

Core invariants:

- The model may propose a commitment; deterministic code approves it against the operation mandate.
- A commitment remains `proposed` until call completion triggers a written recap.
- A commitment becomes `effective` only after the recap adapter confirms delivery.
- Every commitment requires an audio evidence range and conversation item ID.
- Uncorrelated inbound calls start in restricted intake mode and must identify an operation before negotiating.
- Human escalation transfers the live SIP call; it does not hang up first.

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Useful checks:

```bash
npm test
npm run typecheck
```

## API surface

- `POST /v1/operations` creates an operation and mandate.
- `GET /v1/operations/:id` returns the operation, calls, events, and commitments.
- `POST /v1/operations/:id/calls` requests an outbound carrier call.
- `POST /v1/webhooks/openai` verifies and handles `realtime.call.incoming`.
- `POST /v1/calls/:id/control` injects context, transfers, or hangs up.
- `POST /v1/calls/:id/complete` closes a call and delivers recaps for approved proposals.

See `.env.example` for provider contracts. The outbound adapter receives the destination, internal correlation IDs, and OpenAI SIP URI. The recap adapter receives a delivery target and structured commitment recap.

## OpenAI SIP setup

1. Configure an OpenAI project webhook pointing to `/v1/webhooks/openai`.
2. Configure the SIP trunk to route calls to `sip:$PROJECT_ID@sip.api.openai.com;transport=tls`.
3. Preserve `X-Internal-Call-ID` and `X-Operation-ID` SIP headers on outbound calls when the provider supports custom headers.
4. Set `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`, and `OPENAI_SIP_URI`.

## Explicitly deferred

- A concrete Twilio/provider adapter and callback signature verification.
- Durable background jobs and automatic retries for dial and recap delivery. Repeating the completion request retries failed recaps.
- Provider recording ingestion and authoritative audio-offset reconciliation.
- Carrier identity/voice verification and synthetic-agent detection.
- Three-carrier market scheduling, quote comparison, and winner selection.
- Multi-instance sideband ownership, reconnects, and distributed locking.
