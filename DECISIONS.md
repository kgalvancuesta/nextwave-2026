# Decision log

Every entry is a decision we could have made differently. It records the
alternative we rejected and the reason, so a reviewer can disagree with the
reasoning rather than guess at it. Each one points at the code that implements
it.

---

## 1. The tool surface is the policy boundary, not the prompt

**Decision.** What an agent may do on a call is decided by which tools exist in
the session it was accepted with. A procurement call has no
`propose_commitment` in its list at all.

**Alternative rejected.** Give every call the same tools and instruct the model
when not to use them.

**Why.** A prompt is a request; a missing function is an impossibility. No
amount of conversational pressure can invoke a tool that was never in the
config. `OpenAIRealtimeSIP.buildInitialConfig` serializes the agent and that
same payload accepts the SIP leg, so the model can never answer with a broader
surface than its call kind allows.

`lib/volta/agent/agent-tools.ts` (`toolsForKind`) · `lib/volta/openai-agents-runtime.ts`

---

## 2. The model is re-validated even though the SDK already enforced a schema

**Decision.** Every tool argument is parsed again with zod inside
`executeAgentTool`, after the Agents SDK has already applied a strict JSON
schema.

**Alternative rejected.** Trust the SDK's schema and skip the second parse.

**Why.** The SDK's schema protects against malformed payloads. It does not make
the caller trustworthy. The model stays an untrusted caller on the way in, and
the `callId` it writes to is captured in a server-side closure rather than
passed as an argument, so an agent cannot write into another carrier's lane.

`lib/volta/voice-control-service.ts` (`executeAgentTool`)

---

## 3. Call identity travels in SIP headers, never in the prompt

**Decision.** `X-Internal-Call-ID` and `X-Operation-ID` are injected into the
INVITE by the server. Headers with those names already present on the base URI
are stripped case-insensitively first.

**Alternative rejected.** Tell the agent which operation it is on, or ask the
counterparty.

**Why.** The agent should never be the source of truth for which negotiation it
is in. A misconfigured base URI must not be able to smuggle an ambiguous value
ahead of the server's own. An uncorrelated leg is declined politely rather than
bridged, because with no ledger row there is nothing to hold the agent's tool
calls to.

`lib/volta/sip.ts` (`buildCorrelatedSipUri`) · `lib/voice-session.ts`

---

## 4. A rejected tool call returns structured refusal, not an exception

**Decision.** `errorFunction` converts a policy rejection into JSON the model
can act on — `{ ok: false, retry: true, escalate: false, instruction: "..." }`.

**Alternative rejected.** Let the error propagate as an opaque string.

**Why.** A rejection is a normal negotiation outcome, not a crash. Telling the
model *how* to recover keeps it from escalating over a payload format error.
The procurement variant says so explicitly: a stale-revision or date-format
error is not a reason to request a human.

`lib/volta/agent/agent-tools.ts` (`toolFailure`, `procurementToolFailure`)

---

## 5. Optional tool fields are nullable, not absent

**Decision.** Every commercial field is declared `.nullable()` and the nulls are
stripped before the deterministic layer sees them.

**Alternative rejected.** Mark fields optional and let the model omit them.

**Why.** Strict JSON schemas require every key. Making the model supply `null`
explicitly distinguishes "the carrier has not said this yet" from "the model
forgot to ask", which is the difference the evaluator needs to decide between
`ASK_MISSING_FIELD` and `HOLD`.

`lib/volta/agent/agent-tools.ts` (`procurementUpdateArgs`, `procurementPatch`)

---

## 6. Guardrails run on the agent's own transcript, in-call

**Decision.** Output guardrails trip while the agent speaks, in Spanish and
English, on unapproved booking claims and on disclosure of the buy-side ceiling.

**Alternative rejected.** Review transcripts after the call.

**Why.** A post-mortem tells you what the carrier was already told. Catching it
in-call lets the model correct itself. These are explicitly a *second* line of
defence: they are regexes, and the real control is the tool surface (#1).

`lib/volta/agent/agent-guardrails.ts`

---

## 7. The agent brief is a pure function of server state

**Decision.** `buildAgentProfile` and the procurement `getProfile` take server
state and return instructions plus a call kind. Nothing derived from the
conversation feeds back into them.

**Alternative rejected.** Let the agent accumulate context and adjust its own
brief.

**Why.** The same state must always produce the same tool surface, or the
surface stops being auditable. A live call is re-briefed only when server state
grants it a *wider* surface — for example when an inbound caller successfully
identifies their order.

`lib/volta/agent/instructions.ts` · `lib/procurement-voice.ts` (`getProfile`)

---

## 8. One market evaluator steers all three calls, not three independent agents

**Decision.** `evaluateMarket` takes every live lane at once and returns one
instruction per carrier: `ASK_MISSING_FIELD`, `HOLD`, `NEGOTIATE`, `RELEASE`,
`AWARD`. A revision number stamps each decision, and changes are pushed into
the *other* live calls by sideband injection.

**Alternative rejected.** Let each call negotiate independently and compare the
results at the end.

**Why.** Independent agents cannot hold a strong carrier while a slower lane
resolves, and cannot release a carrier the moment it becomes Pareto-dominated.
Comparing only at the end wastes the leverage of having three carriers on the
phone simultaneously. The revision number is what makes a stale instruction
detectable: `validateCallInstruction` rejects an action computed against an
older market.

`lib/procurement-evaluator.ts` · `lib/volta/voice-control-service.ts` (`propagateProcurementUpdates`)

---

## 9. Counters are computed by the server, never invented by the model

**Decision.** `negotiationInstruction` returns an explicit `targetPrice`. The
brief says: *"Ask once, plainly, whether they can do that exact price... Never
invent your own number... never pressure or persuade."*

**Alternative rejected.** Let the model negotiate freely within the mandate,
and/or negotiate arrival as well as price.

**Why.** A mandate bounds the outcome but not the path. A model free to pick
its own counter can anchor badly, concede early, or reveal the ceiling by
implication. The server knows the whole market; the model knows one call.
Price-only, one ask, no persuasion keeps this scriptable and verifiable: a
committed arrival time carries its own hard-constraint checks elsewhere, and
negotiating it too would double what a single round has to track for little
gain — the field was in the original implementation and was cut on
restoration for that reason.

`lib/procurement-evaluator.ts` (`negotiationInstruction`)

---

## 10. No feasible offer means human review, never the least-bad offer

**Decision.** When discovery closes with zero complete feasible offers, the
market goes to `HUMAN_REVIEW` with a reason. Automatic award is prohibited.

**Alternative rejected.** Award the closest offer and flag it.

**Why.** "Closest to legal" is not legal. A hard constraint that bends under
pressure is not a constraint. Near-feasible offers are still surfaced to the
operator as decision support — the human may knowingly break the mandate; the
agent may not.

`lib/procurement-evaluator.ts` (`noFeasibleReviewReason`) · `components/order-workspace.tsx`

---

## 11. The award is a transaction that re-verifies everything it already checked

**Decision.** Inside the SQLite transaction, `awardAutomatically` re-reads the
market revision, re-confirms the winning offer is still the newest version for
that carrier, re-runs the feasibility check, and re-asserts that no active
commitment exists.

**Alternative rejected.** Trust the evaluation that decided to award.

**Why.** Between evaluating and committing, a late inbound call can record a
new offer version. The evaluation is a snapshot; the award must be atomic
against the state it actually writes to. A partial unique index also prevents
two active commitments for one market at the schema level.

`lib/market-service.ts` (`awardAutomatically`) · `db/schema.ts`

---

## 12. A late better offer is recorded but never revokes a closed award

**Decision.** An inbound call after the market closes is attached with status
`CLOSED`, its offer is stored, and the existing commitment stands.

**Alternative rejected.** Re-open the market when a better price arrives.

**Why.** A commitment the carrier has already accepted verbally is an
obligation, not a bid. Silently switching would make every award provisional
and unusable operationally. The better offer still enters the audit trail, so
the operator can see what was left on the table.

`lib/market-service.ts` (`attachInboundCallToMarket`) · `test/procurement-workflow.test.ts`

---

## 13. The recap is frozen in the award transaction, delivered separately

**Decision.** The SMS body is built from persisted server state and written
next to the commitment inside the award transaction. Delivery is a separate,
retryable step that marks `FAILED` after three attempts.

**Alternative rejected.** Send the SMS as part of the award, and roll back if
it fails.

**Why.** A Twilio outage must not roll back a booking the carrier already
accepted on the phone. Freezing the body inside the transaction means the
message the carrier receives is provably the commitment the dashboard holds —
the audit record and the sent text cannot drift. A recap that never sends
surfaces in the commitment panel rather than disappearing.

`lib/market-service.ts` (`queueRecap`) · `lib/recap-service.ts` · `lib/recap.ts`

---

## 14. Audio evidence is timed by the server, not by the model

**Decision.** The model supplies only the conversation item id it already owns.
The offset into the recording is computed server-side — from the recording's own
start time once Twilio reports it, from the answered leg before that.

**Alternative rejected.** Have the model report the audio range, as the older
`record_carrier_quote` tool does.

**Why.** If the model reports the offset, it can place a fact at a moment where
it was not said — which is exactly what evidence must prevent. Evidence is also
bound to the offer version that captured it and never inherited by a later
version, so version 2 cannot claim version 1's audio.

`lib/market-service.ts` (`evidenceOffset`, `attachEvidence`) · `db/schema.ts` migration 009

---

## 15. Recording media is proxied, never linked

**Decision.** The dashboard plays audio through `/api/offers/:id/audio`, which
streams from Twilio using account credentials server-side.

**Alternative rejected.** Put the Twilio recording URL in the page.

**Why.** Twilio media URLs need account credentials; handing them to the browser
either leaks credentials or produces a dead link. The proxy route also inherits
the dashboard's existing basic-auth proxy, so carrier audio sits behind exactly
one door.

`app/api/offers/[id]/audio/route.ts` · `proxy.ts`

---

## 16. Escalation always succeeds; only its delivery can fail

**Decision.** `request_human_escalation` records the escalation and pauses the
lane, then attempts a live transfer. With no target configured, or if the SIP
refer fails, it returns a callback promise and a closing line, and
`finish_procurement_call` accepts `HUMAN_REQUIRED` as a terminal disposition.

**Alternative rejected.** Return `ok: false` when no transfer target is
configured — which is what the code did until we tested it.

**Why.** The one outcome that must never happen is a counterparty left on an
open line with an agent that has no authority left. Reporting failure made the
model believe the escalation itself had failed, and the paused lane also blocked
the only tool that could end the call. The escalation is a policy decision and
it is complete the moment the server records it; the transfer is only how it is
delivered.

`lib/volta/voice-control-service.ts` (`request_human_escalation`) · `test/human-escalation.test.ts`

---

## 17. The opening greeting waits for silence

**Decision.** `OpeningResponseCoordinator` holds the first response until the
remote side has been quiet for 750 ms, letting semantic VAD answer first when it
can.

**Alternative rejected.** Send `response.create` as soon as the session
connects.

**Why.** Carrier greetings and voicemail often start while the SIP sideband is
still connecting. Speaking into that window gets the opening interrupted before
any audio is heard — the failure looks like the agent said nothing at all.

`lib/volta/openai-agents-runtime.ts` (`OpeningResponseCoordinator`)

---

## 18. Volta shares the telephony ledger's `calls` table

**Decision.** One `calls` table. Twilio owns `status` (what the phone leg is
doing); Volta owns `volta_status` (what the agent session is doing). Both are
kept.

**Alternative rejected.** A separate call table for the agent layer.

**Why.** The dashboard, the Twilio status callbacks, the recordings and the
carrier market must all be looking at the same call. Two tables means two
truths. The two status columns are kept because they describe genuinely
different things, and a Twilio-reported state is never rewound by the agent
session.

`lib/volta/store.ts` · `db/schema.ts`

---

## 19. The voice layer is optional and fails loudly when half-configured

**Decision.** `resolveVoiceSession()` falls back to a placeholder greeting when
OpenAI config is missing, but `getVoiceControlService()` throws.

**Alternative rejected.** Degrade silently everywhere.

**Why.** The telephony dashboard is useful on its own, so a missing agent should
not break it. But no agent should answer a carrier with no negotiation policy
loaded — that is the one case where a loud failure is safer than a quiet one.

`lib/voice-session.ts` · `lib/volta/service.ts` · `lib/config.ts`

---

## 20. Spoken time is server-formatted; the model never speaks ISO

**Decision.** The server renders every timestamp in a named time zone and the
agent reads it verbatim. It may not convert, recalculate, or relabel a date.

**Alternative rejected.** Pass ISO timestamps and let the model phrase them.

**Why.** A model that reformats time will eventually reformat it wrong, and a
disputed pickup hour is exactly the fact a recap exists to settle. The zone is
always named so a timestamp is never ambiguous.

`lib/procurement-voice.ts` (`buildOrderConfirmationMessage`) · `lib/recap.ts`

---

## Known limitations

We would rather name these than have them found.

- **Sideband sessions are per-process.** `VoiceControlService` holds live
  sessions in an in-memory `Map`. A second instance cannot control a call the
  first one accepted; it says so rather than failing silently. Correct fix is a
  shared session registry.
- **The procurement deadline is evaluated on dashboard poll.**
  `reevaluateExpiredMarkets()` runs inside `GET /api/orders`. With nobody
  polling, an unanswered lane holds the market past its deadline. Correct fix is
  a server-side timer.
- **Migration ids collide after a merge.** Two `008_` and two `009_` ids exist.
  They execute in array order and apply correctly, but the numbering no longer
  communicates order.
- **Two time-zone constants.** `PROCUREMENT_TIME_ZONE` and `RECAP_TIME_ZONE`
  encode the same idea in different files. They agree today; nothing enforces
  that they keep agreeing.
- **Escalation without a transfer target ends the call politely but does not
  reach a human automatically.** The lane is paused and the reason is recorded
  for an operator to pick up; nobody is paged.
