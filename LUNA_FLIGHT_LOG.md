# Decision Log — Semantiks

NextWave Hackathon 2026 · Mexico City

## 1. Define the core product.  `T+22:28`

**Options considered**

- A voice agent that calls freight carriers
- A freight procurement assistant
- A live competitive market for each load

**Chosen:** Build a competitive freight market around each load, with Luna as the voice interface.

**Why:** Parallel phone calls alone are not differentiated. The stronger product is the shared market: multiple carriers compete on price and timing, offers become comparable, and the system selects the best feasible commitment.

## 2. Choose the durable unit around which state is organized.  `T+22:28`

**Options considered**

- Individual phone calls
- Carrier conversations
- Orders/loads

**Chosen:** Make the order the persistent top-level object. Calls, offers, markets, commitments, and recovery attempts all belong to an order.

**Why:** A shipment persists across many calls and can require sourcing again after an initial booking fails. Modeling the order as the durable object keeps that history together.

## 3. Determine how parallel Luna instances share information.  `T+22:28`

**Options considered**

- Sequential calls
- Agents sharing transcript/conversation state
- Independent calls sharing structured server-side market state

**Chosen:** Call carriers in parallel, with every Luna instance reading and updating one authoritative server-side market.

**Why:** Parallel calling reduces sourcing time and creates competition. Structured shared state avoids coupling conversations together and gives every call the same authoritative shipment context.

## 4. Choose the authority boundary between Luna and the backend.  `T+22:29`

**Options considered**

- Let the voice model decide
- Use another AI evaluator
- Use deterministic server-side rules

**Chosen:** The server owns hard-constraint validation, feasibility, ranking, market closure, and award.

**Why:** These are transactional decisions that must be deterministic and auditable. Luna should understand language and gather information, but it should not independently decide whether a carrier satisfies the shipment or gets booked.

## 5. Decide whether the first acceptable offer should win immediately.  `T+22:29`

**Options considered**

- First feasible carrier wins
- Wait for every possible carrier indefinitely
- Record/hold offers while the active sourcing batch completes

**Chosen:** Do not equate first response with winner. Record comparable offers and award based on the resulting market.

**Why:** A fast response is not necessarily the best price or service. The purpose of calling carriers in parallel is lost if the first caller automatically wins.

## 6. Determine whether Luna may accept attractive offers outside the requested constraints.  `T+22:29`

**Options considered**

- Treat constraints as preferences
- Allow AI judgment to relax them
- Treat mandatory constraints as hard boundaries

**Chosen:** The evaluator never automatically accepts an offer outside the hard constraint space.

**Why:** A cheaper quote that cannot actually satisfy the shipment is not a valid solution. If no feasible offer exists, the system should show the available market and hand the decision to a human.

## 7. Choose how discovery and negotiation interact.  `T+22:30`

**Options considered**

- Negotiate aggressively during every initial call
- Never negotiate
- First collect comparable offers, then negotiate selectively

**Chosen:** Use initial calls primarily for feasibility and structured quote discovery, with negotiation applied selectively afterward.

**Why:** Negotiating before understanding the market can waste time and reveal leverage too early. Comparable offers first give the system a better basis for deciding where negotiation is worthwhile.

## 8. Determine whether Luna should infer the procurement workflow from one large prompt.  `T+22:30`

**Options considered**

- Put the entire workflow in the system prompt
- Let Luna improvise state transitions
- Keep prompts narrow and have the server return the next permitted action

**Chosen:** Move workflow control into the backend/state machine. Luna receives concise instructions for the current situation.

**Why:** Large prompts produced conflicting instructions, unnecessary talking, loops, and incorrect transitions. The model performs much better when it handles one conversational task at a time.

## 9. Resolve conflicts between the voice model and downstream parsing.  `T+22:30`

**Options considered**

- Trust only a deterministic transcript parser
- Add another LLM to normalize time expressions
- Let Luna produce candidate normalized values and have the server validate them

**Chosen:** Luna interprets conversational time expressions into candidate structured timestamps; the server validates plausibility, ordering, and constraints.

**Why:** The voice model was correctly understanding natural speech while a stricter parser sometimes deleted valid results because it could not independently reproduce the interpretation. A second LLM or giant custom parser would add unnecessary latency and complexity.

## 10. Decide whether extracted fields alone are enough to create a carrier commitment.  `T+22:31`

**Options considered**

- Trust the model's structured extraction immediately
- Require manual review
- Read back canonical terms and obtain explicit carrier confirmation

**Chosen:** A quote is not locked until Luna reads back the server-generated terms and the carrier explicitly confirms them.

**Why:** Natural-language interpretation can be probabilistic. Canonical readback plus confirmation creates a clear boundary between inferred information and an actual carrier commitment.

## 11. Determine whether Luna may freely paraphrase confirmed shipment terms.  `T+22:31`

**Options considered**

- Let Luna summarize naturally
- Generate exact transactional recaps on the server
- Require human-written scripts for every call

**Chosen:** The server generates canonical order, retained-offer, and award readbacks that Luna reads exactly.

**Why:** Prices, dates, pickup times, arrival times, and shipment requirements need to remain consistent between the database, dashboard, and spoken confirmation.

## 12. Decide whether the system ends once a carrier is booked.  `T+22:31`

**Options considered**

- Treat award as the end of automation
- Accept whatever changes the booked carrier requests
- Allow Luna to process bounded amendments and reevaluate the commitment

**Chosen:** Support inbound post-award calls. Luna may autonomously handle price, pickup-time, and arrival-time changes, subject to server approval.

**Why:** Real freight commitments change after booking. Handling disruption is substantially more valuable than demonstrating only a happy-path procurement call.

## 13. Choose between immediately abandoning the carrier and accepting its changed terms.  `T+22:32`

**Options considered**

- Accept the amendment
- Immediately replace the carrier
- Give Luna a bounded server-directed counteroffer before recovery

**Chosen:** Allow a limited negotiation cycle using server-provided targets. If the carrier cannot return to acceptable terms, open recovery.

**Why:** A small concession may preserve the existing booking without requiring a full replacement, but Luna must never accept terms that violate the shipment mandate.

## 14. Determine where replacement capacity should come from.  `T+22:32`

**Options considered**

- Start sourcing from zero
- Only call carriers from the original market
- Revalidate previous offers first, then expand into the larger carrier database

**Chosen:** Reuse retained offers as the fastest recovery path, then contact additional carriers likely to cover the specific load if the previous market is exhausted.

**Why:** The original market contains valuable information and should not be discarded. However, limiting recovery to those carriers would unnecessarily cap the system's ability to rescue the shipment.

## 15. Choose the central story for judges and users.  `T+22:32`

**Options considered**

- “AI voice agent for freight”
- “Parallel carrier calling”
- “A competitive market for every load, including automatic recovery”

**Chosen:** Position Luna as freight market-making infrastructure: it calls carriers, creates competition, selects the best feasible commitment, and reopens the market when that commitment breaks.

**Why:** Voice is the interface, not the moat. The more compelling economic story is continuous price discovery, negotiation leverage, and recovery—especially during nights and other periods when human freight operations are thinly staffed.
