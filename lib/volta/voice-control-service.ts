import { z } from "zod";
import type { AgentCallProfile } from "./agent/agent-context";
import { buildAgentProfile } from "./agent/instructions";
import { normalizeCarrier, sameCarrier } from "./carriers";
import { evaluateMandate } from "./mandate";
import {
  carrierCandidateSchema,
  carrierQuoteTermsSchema,
  commitmentProposalSchema,
  operationInputSchema,
  type CallRecord,
  type CarrierCandidate,
  type CarrierMarket,
  type CarrierQuote,
} from "./models";
import type {
  AgentCallSession,
  OutboundTelephonyGateway,
  RealtimeAgentGateway,
  RecapGateway,
  StateStore,
  ProcurementVoicePort,
  ProcurementControlUpdate,
} from "./ports";

interface ServiceOptions {
  /** The Twilio sender every negotiation call is placed from. */
  fromNumber: string;
  sipUri: string | undefined;
  humanEscalationUri: string | undefined;
}

const incomingEventSchema = z.object({
  type: z.string(),
  data: z.object({
    call_id: z.string(),
    sip_headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  }),
});

export class VoiceControlService {
  private readonly sessions = new Map<string, AgentCallSession>();

  constructor(
    private readonly store: StateStore,
    private readonly realtime: RealtimeAgentGateway,
    private readonly telephony: OutboundTelephonyGateway,
    private readonly recaps: RecapGateway,
    private readonly options: ServiceOptions,
    private readonly procurement?: ProcurementVoicePort,
  ) {}

  createOperation(input: unknown) {
    return this.store.createOperation(operationInputSchema.parse(input));
  }

  getOperationSnapshot(id: string) {
    return this.store.getOperationSnapshot(id);
  }

  async startOutboundCall(
    operationId: string,
    to: string,
    counterparty?: string,
    marketId?: string,
  ): Promise<CallRecord> {
    const operation = this.requireOperation(operationId);
    if (!this.options.sipUri) throw new Error("OPENAI_SIP_URI is not configured");
    if (marketId) {
      const market = this.requireCarrierMarket(marketId);
      if (market.operationId !== operation.id) {
        throw new Error(`Carrier market ${market.id} does not belong to operation ${operation.id}`);
      }
    }
    const call = this.store.createCall({
      operationId: operation.id,
      ...(marketId ? { marketId } : {}),
      direction: "outbound",
      counterparty: counterparty ?? to,
      fromNumber: this.options.fromNumber,
      toNumber: to,
      status: "dialing",
      providerCallId: null,
      realtimeCallId: null,
    });
    this.store.appendEvent(call.id, "outbound_call.requested", { to, counterparty, marketId: marketId ?? null });
    try {
      const result = await this.telephony.dial({ to, internalCallId: call.id, operationId });
      this.store.updateCall(call.id, { providerCallId: result.providerCallId });
      return this.store.getCall(call.id)!;
    } catch (error) {
      this.store.updateCall(call.id, { status: "failed", endedAt: new Date().toISOString() });
      this.store.appendEvent(call.id, "outbound_call.failed", { message: errorMessage(error) });
      throw error;
    }
  }

  /**
   * Fan out the recovery request to the carrier market. All dial requests are
   * initiated before awaiting any provider result, so a slow first carrier
   * cannot serialize the other negotiations.
   */
  async startCarrierMarket(operationId: string, candidatesInput: unknown): Promise<{
    market: CarrierMarket;
    calls: CallRecord[];
    failures: Array<{ carrier: CarrierCandidate; error: string }>;
  }> {
    const operation = this.requireOperation(operationId);
    const candidates = z.array(carrierCandidateSchema).min(operation.minimumCarrierCalls).parse(candidatesInput);
    assertDistinctCandidates(candidates);

    const market = this.store.createCarrierMarket({ operationId: operation.id, candidates });
    this.store.updateCarrierMarket(market.id, { status: "collecting_quotes" });

    const results = await Promise.allSettled(
      candidates.map((carrier) => this.startOutboundCall(operation.id, carrier.phone, carrier.name, market.id)),
    );
    const calls: CallRecord[] = [];
    const failures: Array<{ carrier: CarrierCandidate; error: string }> = [];
    for (const [index, result] of results.entries()) {
      const carrier = candidates[index];
      if (!carrier) continue;
      if (result.status === "fulfilled") {
        calls.push(result.value);
      } else {
        failures.push({ carrier, error: errorMessage(result.reason) });
      }
    }

    if (calls.length === 0) {
      const exhausted = this.store.updateCarrierMarket(market.id, {
        status: "exhausted",
        closedAt: new Date().toISOString(),
      });
      return { market: exhausted, calls, failures };
    }
    return { market: this.requireCarrierMarket(market.id), calls, failures };
  }

  /** Store a quote independently from a final booking; rejected quotes stay in the audit trail. */
  recordCarrierQuote(callId: string, termsInput: unknown): CarrierQuote {
    const call = this.requireCall(callId);
    if (!call.operationId) throw new Error("Cannot record a quote for an unassigned call");
    if (!call.marketId) throw new Error("Call is not part of a carrier market");
    const operation = this.requireOperation(call.operationId);
    const market = this.requireCarrierMarket(call.marketId);
    const carrier = this.resolveMarketCarrier(market, call);
    const terms = carrierQuoteTermsSchema.parse(termsInput);
    const mandateDecision = evaluateMandate(operation.mandate, terms);
    const quote = this.store.createCarrierQuote({
      marketId: market.id,
      carrier,
      callId: call.id,
      terms,
      mandateDecision,
    });
    this.store.appendEvent(call.id, "carrier_quote.recorded", {
      marketId: market.id,
      quoteId: quote.id,
      carrier: carrier.name,
      mandateDecision,
    });

    this.refreshMarketReadiness(market.id);
    return quote;
  }

  /**
   * Select the deterministic best eligible quote. A human can see the result
   * in the UI, but cannot silently choose a more expensive or non-compliant
   * offer. Exceptions remain an explicit live escalation.
   */
  selectBestCarrierQuote(marketId: string): { market: CarrierMarket; quote: CarrierQuote } {
    const market = this.requireCarrierMarket(marketId);
    const operation = this.requireOperation(market.operationId);
    const attemptedCarriers = this.marketAttemptedCarrierNames(market);
    if (attemptedCarriers.size < operation.minimumCarrierCalls) {
      throw new Error(
        `minimum_carrier_calls_not_met: ${attemptedCarriers.size}/${operation.minimumCarrierCalls} distinct carrier calls started`,
      );
    }

    const quotes = this.store.listCarrierQuotes(market.id);
    const eligible = quotes.filter((quote) => quote.mandateDecision.allowed);
    if (eligible.length === 0) {
      const exhausted = this.store.updateCarrierMarket(market.id, {
        status: "exhausted",
        closedAt: new Date().toISOString(),
      });
      this.appendMarketEvent(exhausted, "carrier_market.exhausted", { reason: "no_eligible_quotes" });
      throw new Error("no_eligible_quotes: human escalation is required");
    }

    const best = eligible.sort(compareEligibleQuotes)[0];
    if (!best) throw new Error("no_eligible_quotes: human escalation is required");
    const selected = this.store.selectCarrierQuote({ marketId: market.id, quoteId: best.id });
    this.appendMarketEvent(selected, "carrier_market.selected", {
      quoteId: best.id,
      carrier: best.carrier.name,
      rate: best.terms.rate,
      pickupWindow: best.terms.pickupWindow,
      reliabilityScore: best.carrier.reliabilityScore,
    });
    return { market: selected, quote: best };
  }

  /** Start the final read-back call only after the market policy has selected a winner. */
  async startSelectedCarrierConfirmation(marketId: string): Promise<CallRecord> {
    const market = this.requireCarrierMarket(marketId);
    if (!market.selectedQuoteId) throw new Error("carrier_market_has_no_selected_quote");
    const quote = this.requireCarrierQuote(market.selectedQuoteId);
    const call = await this.startOutboundCall(market.operationId, quote.carrier.phone, quote.carrier.name, market.id);
    this.store.appendEvent(call.id, "carrier_market.confirmation_requested", {
      marketId: market.id,
      quoteId: quote.id,
      carrier: quote.carrier.name,
    });
    return call;
  }

  async handleOpenAiWebhook(eventInput: unknown): Promise<{ callId?: string; ignored?: boolean }> {
    const event = incomingEventSchema.parse(eventInput);
    if (event.type !== "realtime.call.incoming") return { ignored: true };

    const realtimeCallId = event.data.call_id;
    const existingRealtimeCall = this.store.findCallByRealtimeId(realtimeCallId);
    if (existingRealtimeCall) return { callId: existingRealtimeCall.id };

    const headers = new Map(event.data.sip_headers.map((header) => [header.name.toLowerCase(), header.value]));
    const internalCallId = cleanHeader(headers.get("x-internal-call-id"));
    const operationId = cleanHeader(headers.get("x-operation-id"));
    const from = headers.get("from") ?? null;

    let call = internalCallId ? this.store.getCall(internalCallId) : null;
    if (!call) {
      const operation = operationId ? this.store.getOperation(operationId) : null;
      call = this.store.createCall({
        operationId: operation?.id ?? null,
        direction: "inbound",
        counterparty: from,
        fromNumber: from ?? "unknown",
        toNumber: this.options.fromNumber,
        status: "active",
        providerCallId: null,
        realtimeCallId,
      });
    } else {
      this.store.updateCall(call.id, { status: "active", realtimeCallId });
      call = this.store.getCall(call.id)!;
    }

    this.procurement?.prepareCall(call.id);

    const attachedCallId = call.id;
    const profile = this.buildCallProfile(call);
    const session = await this.realtime.startCall({
      realtimeCallId,
      callId: attachedCallId,
      profile,
      invokeTool: (name, args) => this.executeAgentTool(attachedCallId, name, args),
      onAudit: (type, payload) => { this.store.appendEvent(attachedCallId, type, payload); },
    });
    this.sessions.set(attachedCallId, session);
    this.store.appendEvent(attachedCallId, "realtime.call.accepted", {
      realtimeCallId,
      agentKind: profile.kind,
      correlated: Boolean(call.operationId),
    });
    session.requestResponse();
    return { callId: attachedCallId };
  }

  async controlCall(callId: string, action: "inject_context" | "transfer" | "hangup", value?: string): Promise<void> {
    const call = this.requireCall(callId);
    if (!call.realtimeCallId) throw new Error("Call has no active Realtime session");

    if (action === "inject_context") {
      if (!value) throw new Error("inject_context requires value");
      const session = this.sessions.get(call.id);
      if (!session) throw new Error("Sideband session is not owned by this process");
      session.injectContext(value);
      this.store.appendEvent(call.id, "control.context_injected", { value });
      return;
    }

    if (action === "transfer") {
      const target = value ?? this.options.humanEscalationUri;
      if (!target) throw new Error("No human escalation URI is configured");
      await this.realtime.transfer(call.realtimeCallId, target);
      this.store.updateCall(call.id, { status: "transferred", endedAt: new Date().toISOString() });
      this.store.appendEvent(call.id, "control.transferred", { target });
      return;
    }

    await this.realtime.hangup(call.realtimeCallId);
    this.store.updateCall(call.id, { status: "completed", endedAt: new Date().toISOString() });
    this.store.appendEvent(call.id, "control.hung_up", {});
  }

  async completeCall(callId: string) {
    const call = this.requireCall(callId);
    if (!call.operationId) throw new Error("Cannot complete an unassigned call");
    const operation = this.requireOperation(call.operationId);
    const outcomes: Array<{ commitmentId: string; status: "effective" | "recap_failed"; error?: string }> = [];

    for (const commitment of this.store.listPendingCommitments(call.id)) {
      try {
        const delivery = await this.recaps.deliver({
          channel: commitment.recapTarget.channel,
          address: commitment.recapTarget.address,
          commitmentId: commitment.id,
          operationReference: operation.externalReference,
          summary: commitment.summary,
        });
        this.store.updateCommitment(commitment.id, "effective", delivery.deliveryId);
        outcomes.push({ commitmentId: commitment.id, status: "effective" });
      } catch (error) {
        this.store.updateCommitment(commitment.id, "recap_failed");
        outcomes.push({ commitmentId: commitment.id, status: "recap_failed", error: errorMessage(error) });
      }
    }

    this.store.updateCall(call.id, { status: "completed", endedAt: new Date().toISOString() });
    this.store.appendEvent(call.id, "call.completed", { recapOutcomes: outcomes });
    this.sessions.get(call.id)?.close();
    this.sessions.delete(call.id);
    return outcomes;
  }

  /**
   * The deterministic half of every agent tool call. The Realtime agent can
   * only reach an operation through this method, and each branch re-validates
   * its own arguments: the model stays an untrusted caller even though the
   * Agents SDK already enforced a JSON schema on the way in.
   */
  async executeAgentTool(callId: string, name: string, rawArgs: unknown): Promise<unknown> {
    const args = z.record(z.string(), z.unknown()).parse(rawArgs);
    const call = this.requireCall(callId);

    if (name === "identify_operation") {
      if (call.operationId) return { ok: true, operation_id: call.operationId, already_attached: true };
      const reference = z.string().min(1).parse(args.external_reference);
      const procurement = this.procurement?.identifyCall(call.id, reference);
      if (procurement?.attached) {
        await this.refreshCallProfile(call.id);
        return { ok: true, procurement_market_attached: true, attachment: procurement.result };
      }
      const operation = this.store.findOperationByReference(reference);
      if (!operation) return { ok: false, error: "operation_not_found", escalate: true };
      this.store.attachCallToOperation(call.id, operation.id);
      this.store.appendEvent(call.id, "operation.identified", { operationId: operation.id, reference });
      // The call just earned a wider tool surface, so re-brief the live agent.
      await this.refreshCallProfile(call.id);
      return { ok: true, operation_id: operation.id, mandate: operation.mandate };
    }

    if (name === "record_brief_item") {
      const brief = z.object({
        category: z.string().min(1),
        detail: z.string().min(1),
        conversation_item_id: z.string().min(1),
      }).parse(args);
      this.store.appendEvent(call.id, "call_brief.item", brief);
      return { ok: true };
    }

    if (name === "record_carrier_quote") {
      const quote = this.recordCarrierQuote(call.id, args);
      return {
        ok: true,
        quote_id: quote.id,
        eligible_within_mandate: quote.mandateDecision.allowed,
        violations: quote.mandateDecision.violations,
        message: quote.mandateDecision.allowed
          ? "Quote recorded. Do not promise a booking until the market selects a winner."
          : "Quote recorded as ineligible. Do not negotiate or promise beyond the mandate.",
      };
    }

    if (name === "record_procurement_update") {
      if (!this.procurement) throw new Error("Procurement workflow is not configured");
      const outcome = this.procurement.recordUpdate(call.id, args);
      this.propagateProcurementUpdates(outcome.controlUpdates);
      // Recording a fact can be the update that closes the market. Deliver the
      // written recap now, while the winning carrier is still on the line.
      await this.procurement.flushRecaps();
      return outcome.result;
    }

    if (name === "get_procurement_instruction") {
      if (!this.procurement) throw new Error("Procurement workflow is not configured");
      return this.procurement.getInstruction(call.id);
    }

    if (name === "finish_procurement_call") {
      if (!this.procurement) throw new Error("Procurement workflow is not configured");
      const marketRevision = z.number().int().nonnegative().parse(args.marketRevision);
      const result = this.procurement.validateFinish(call.id, marketRevision);
      if (call.realtimeCallId) await this.realtime.hangup(call.realtimeCallId);
      this.store.updateCall(call.id, { status: "completed", endedAt: new Date().toISOString() });
      this.store.appendEvent(call.id, "procurement.call_finished", { marketRevision, disposition: args.disposition });
      this.sessions.get(call.id)?.close();
      this.sessions.delete(call.id);
      return result;
    }

    if (name === "request_human_escalation") {
      const reason = z.string().min(1).parse(args.reason);
      const procurement = this.procurement?.markHumanRequired(call.id, reason);
      if (procurement) this.propagateProcurementUpdates(procurement.controlUpdates);
      if (!call.realtimeCallId || !this.options.humanEscalationUri) {
        this.store.appendEvent(call.id, "escalation.failed", { reason, error: "target_not_configured" });
        return { ok: false, error: "human escalation target is not configured" };
      }
      await this.realtime.transfer(call.realtimeCallId, this.options.humanEscalationUri);
      this.store.updateCall(call.id, { status: "transferred", endedAt: new Date().toISOString() });
      this.store.appendEvent(call.id, "escalation.transferred", { reason, target: this.options.humanEscalationUri });
      return { ok: true, transferred: true };
    }

    if (name === "propose_commitment") {
      const currentCall = this.requireCall(call.id);
      if (!currentCall.operationId) return { ok: false, error: "operation_not_identified", escalate: true };
      const operation = this.requireOperation(currentCall.operationId);
      const proposal = commitmentProposalSchema.parse(args);
      const mandateDecision = evaluateMandate(operation.mandate, proposal);
      const decision = this.applyMarketCommitmentGate(currentCall, proposal, mandateDecision);
      if (!decision.allowed) {
        this.store.appendEvent(call.id, "commitment.rejected_by_mandate", { proposal, decision });
        return { ok: false, approved: false, violations: decision.violations, escalate: true };
      }
      const record = this.store.createCommitment({
        operationId: operation.id,
        callId: call.id,
        proposal,
        decision,
      });
      this.store.appendEvent(call.id, "commitment.proposed", { commitmentId: record.id, proposal, decision });
      return {
        ok: true,
        approved_within_mandate: true,
        commitment_id: record.id,
        effective: false,
        message: "Verbally approved. It becomes effective only after the written recap is delivered on call completion.",
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Re-derive the brief for a live call. Call this whenever server state that
   * feeds the brief changed underneath an ongoing conversation.
   */
  private async refreshCallProfile(callId: string): Promise<void> {
    const session = this.sessions.get(callId);
    const call = this.store.getCall(callId);
    if (!session || !call) return;
    const profile = this.buildCallProfile(call);
    await session.useProfile(profile);
    this.store.appendEvent(callId, "agent.rebriefed", { agentKind: profile.kind });
  }

  /** The agent brief for a call, derived from server state only. */
  private buildCallProfile(call: CallRecord): AgentCallProfile {
    const procurementProfile = this.procurement?.getProfile(call.id);
    if (procurementProfile) return procurementProfile;
    const operation = call.operationId ? this.store.getOperation(call.operationId) : null;
    const market = call.marketId ? this.store.getCarrierMarket(call.marketId) : null;
    const selectedQuote = market?.selectedQuoteId ? this.store.getCarrierQuote(market.selectedQuoteId) : null;
    return buildAgentProfile({ call, operation, market, selectedQuote });
  }

  private propagateProcurementUpdates(updates: ProcurementControlUpdate[]): void {
    for (const update of updates) {
      const session = this.sessions.get(update.callId);
      if (!session) continue;
      session.injectContext(update.instruction);
      session.requestResponse();
      this.store.appendEvent(update.callId, "procurement.market_instruction_updated", { instruction: update.instruction });
    }
  }

  private refreshMarketReadiness(marketId: string): void {
    const market = this.requireCarrierMarket(marketId);
    if (market.status === "selected" || market.status === "exhausted" || market.status === "cancelled") return;
    const operation = this.requireOperation(market.operationId);
    const attempts = this.marketAttemptedCarrierNames(market);
    if (attempts.size >= operation.minimumCarrierCalls) {
      this.store.updateCarrierMarket(market.id, { status: "ready_for_selection" });
    }
  }

  private marketAttemptedCarrierNames(market: CarrierMarket): Set<string> {
    const snapshot = this.store.getOperationSnapshot(market.operationId);
    if (!snapshot) return new Set();
    const candidates = new Map(market.candidates.map((candidate) => [normalizeCarrier(candidate.name), candidate]));
    return new Set(
      snapshot.calls
        .filter((call) => call.marketId === market.id && call.direction === "outbound")
        .map((call) => normalizeCarrier(call.counterparty ?? ""))
        .filter((name) => candidates.has(name)),
    );
  }

  private resolveMarketCarrier(market: CarrierMarket, call: CallRecord): CarrierCandidate {
    const carrier = market.candidates.find((candidate) => sameCarrier(call.counterparty, candidate));
    if (!carrier) {
      throw new Error(`Call ${call.id} is not associated with a known carrier in market ${market.id}`);
    }
    return carrier;
  }

  private applyMarketCommitmentGate(
    call: CallRecord,
    proposal: ReturnType<typeof commitmentProposalSchema.parse>,
    mandateDecision: { allowed: boolean; violations: string[] },
  ): { allowed: boolean; violations: string[] } {
    if (!call.marketId) return mandateDecision;
    const market = this.requireCarrierMarket(call.marketId);
    const violations = [...mandateDecision.violations];
    if (!market.selectedQuoteId) {
      violations.push("carrier market has no selected winner");
      return { allowed: false, violations };
    }
    const selectedQuote = this.requireCarrierQuote(market.selectedQuoteId);
    if (!sameCarrier(call.counterparty, selectedQuote.carrier)) {
      violations.push("final commitment is not with the selected carrier");
    }
    if (!sameCommercialTerms(selectedQuote.terms, proposal)) {
      violations.push("final commitment differs from the selected carrier quote");
    }
    return { allowed: violations.length === 0, violations };
  }

  private appendMarketEvent(market: CarrierMarket, type: string, payload: unknown): void {
    const snapshot = this.store.getOperationSnapshot(market.operationId);
    const call = snapshot?.calls.find((candidate) => candidate.marketId === market.id);
    if (call) this.store.appendEvent(call.id, type, payload);
  }

  private requireCarrierMarket(id: string): CarrierMarket {
    const market = this.store.getCarrierMarket(id);
    if (!market) throw new Error(`Carrier market not found: ${id}`);
    return market;
  }

  private requireCarrierQuote(id: string): CarrierQuote {
    const quote = this.store.getCarrierQuote(id);
    if (!quote) throw new Error(`Carrier quote not found: ${id}`);
    return quote;
  }

  private requireOperation(id: string) {
    const operation = this.store.getOperation(id);
    if (!operation) throw new Error(`Operation not found: ${id}`);
    return operation;
  }

  private requireCall(id: string) {
    const call = this.store.getCall(id);
    if (!call) throw new Error(`Call not found: ${id}`);
    return call;
  }
}

function cleanHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/^['"]|['"]$/g, "").trim() || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertDistinctCandidates(candidates: CarrierCandidate[]): void {
  const names = new Set<string>();
  const phones = new Set<string>();
  for (const carrier of candidates) {
    const name = normalizeCarrier(carrier.name);
    const phone = carrier.phone.replace(/\s+/g, "");
    if (names.has(name) || phones.has(phone)) {
      throw new Error(`duplicate carrier candidate: ${carrier.name}`);
    }
    names.add(name);
    phones.add(phone);
  }
}

function compareEligibleQuotes(left: CarrierQuote, right: CarrierQuote): number {
  const rate = left.terms.rate.amount - right.terms.rate.amount;
  if (rate !== 0) return rate;
  const pickup = Date.parse(left.terms.pickupWindow.start) - Date.parse(right.terms.pickupWindow.start);
  if (pickup !== 0) return pickup;
  const reliability = right.carrier.reliabilityScore - left.carrier.reliabilityScore;
  if (reliability !== 0) return reliability;
  return left.id.localeCompare(right.id);
}

function sameCommercialTerms(
  quote: { rate: { amount: number; currency: string }; pickupWindow: { start: string; end: string }; accessorials: string[]; terms: string[]; detentionMinutes?: number | undefined },
  proposal: { rate: { amount: number; currency: string }; pickupWindow: { start: string; end: string }; accessorials: string[]; terms: string[]; detentionMinutes?: number | undefined },
): boolean {
  return quote.rate.amount === proposal.rate.amount
    && quote.rate.currency === proposal.rate.currency
    && quote.pickupWindow.start === proposal.pickupWindow.start
    && quote.pickupWindow.end === proposal.pickupWindow.end
    && quote.detentionMinutes === proposal.detentionMinutes
    && sameStringSet(quote.accessorials, proposal.accessorials)
    && sameStringSet(quote.terms, proposal.terms);
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].map(normalizeCarrier).sort();
  const normalizedRight = [...right].map(normalizeCarrier).sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}
