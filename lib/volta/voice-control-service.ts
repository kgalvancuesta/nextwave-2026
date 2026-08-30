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

/**
 * Spoken when a human is required but the live leg cannot be handed to one.
 * It commits to a callback, discloses nothing about the order, the market or
 * the reason, and gives the agent an unambiguous way to end the call.
 */
export const HUMAN_CALLBACK_CLOSING =
  "Thank you. I need a member of our operations team to take this from here. "
  + "They will call you back on this number shortly. Goodbye.";

const incomingEventSchema = z.object({
  type: z.string(),
  data: z.object({
    call_id: z.string(),
    sip_headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  }),
});

export class VoiceControlService {
  private readonly sessions = new Map<string, AgentCallSession>();
  private readonly latestCarrierTurns = new Map<string, { itemId: string | null; transcript: string }>();
  private readonly identificationFailures = new Map<string, number>();

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
      onAudit: (type, payload) => {
        this.store.appendEvent(attachedCallId, type, payload);
        const evidence = carrierTurnEvidence(type, payload);
        if (evidence) this.latestCarrierTurns.set(attachedCallId, evidence);
      },
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
      this.releaseCallSession(call.id);
      return;
    }

    await this.realtime.hangup(call.realtimeCallId);
    this.store.updateCall(call.id, { status: "completed", endedAt: new Date().toISOString() });
    this.store.appendEvent(call.id, "control.hung_up", {});
    this.releaseCallSession(call.id);
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
    this.releaseCallSession(call.id);
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
      if (call.operationId) {
        this.identificationFailures.delete(call.id);
        return { ok: true, operation_id: call.operationId, already_attached: true };
      }
      const reference = z.string().min(1).parse(args.external_reference);
      const procurement = this.procurement?.identifyCall(call.id, reference, {
        carrierName: nullableAgentString(args.carrier_name),
        callerName: nullableAgentString(args.caller_name),
        origin: nullableAgentString(args.origin),
        destination: nullableAgentString(args.destination),
      });
      if (procurement?.attached) {
        this.identificationFailures.delete(call.id);
        await this.refreshCallProfile(call.id);
        return { ok: true, procurement_market_attached: true, attachment: procurement.result };
      }
      const procurementResult = objectResult(procurement?.result);
      const candidates = Array.isArray(procurementResult.candidates) ? procurementResult.candidates : [];
      if (procurementResult.status === "AMBIGUOUS" || candidates.length > 0) {
        return this.failedIdentification(call.id, {
          ...procurementResult,
          error: "procurement_identity_incomplete",
        });
      }
      const operation = this.store.findOperationByReference(reference);
      if (!operation) {
        return this.failedIdentification(call.id, {
          error: "operation_not_found",
          suggestedQuestion: procurementResult.suggestedQuestion ?? "Ask the caller to repeat the order/reference number.",
        });
      }
      this.identificationFailures.delete(call.id);
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
      const outcome = this.procurement.recordUpdate(call.id, args, this.latestCarrierTurns.get(call.id) ?? null);
      await this.propagateProcurementUpdates(outcome.controlUpdates);
      await this.procurement.runFollowUps(outcome.followUps ?? []);
      // Recording a fact can close the market. Deliver the persisted recap
      // before replacing the live conversation with its scripted closing.
      await this.procurement.flushRecaps();
      return this.handleAwardClosing(call.id, outcome.result);
    }

    if (name === "propose_procurement_amendment") {
      if (!this.procurement) throw new Error("Procurement workflow is not configured");
      const outcome = this.procurement.proposeAmendment(call.id, args);
      await this.propagateProcurementUpdates(outcome.controlUpdates);
      await this.procurement.runFollowUps(outcome.followUps ?? []);
      return this.handleAwardClosing(call.id, outcome.result);
    }

    if (name === "get_procurement_instruction") {
      if (!this.procurement) throw new Error("Procurement workflow is not configured");
      return this.handleAwardClosing(call.id, this.procurement.getInstruction(call.id));
    }

    if (name === "finish_procurement_call") {
      if (!this.procurement) throw new Error("Procurement workflow is not configured");
      const marketRevision = z.number().int().nonnegative().parse(args.marketRevision);
      const disposition = z.enum(["RELEASE", "COMPLETE", "HUMAN", "QUOTE_RECORDED", "VOICEMAIL"])
        .parse(args.disposition);
      const result = this.procurement.validateFinish(call.id, marketRevision, disposition);
      const closingMessage = closingMessageFrom(result);
      if (!call.providerCallId || !closingMessage) {
        return {
          ...objectResult(result),
          ok: false,
          terminal: false,
          scripted_message_dispatched: false,
          message: "The server could not prepare the audible closing. Keep the call open and retry finish_procurement_call once.",
        };
      }
      try {
        await this.telephony.playMessageAndHangup(call.providerCallId, closingMessage);
      } catch (error) {
        this.store.appendEvent(call.id, "procurement.finish_closing_failed", { error: errorMessage(error) });
        return {
          ...objectResult(result),
          ok: false,
          terminal: false,
          scripted_message_dispatched: false,
          message: "The audible closing did not dispatch. Keep the call open and retry finish_procurement_call once.",
        };
      }
      this.store.updateCall(call.id, { status: "completed", endedAt: new Date().toISOString() });
      this.store.appendEvent(call.id, "procurement.finish_closing_dispatched", { marketRevision, disposition, closingMessage });
      this.releaseCallSession(call.id);
      this.store.appendEvent(call.id, "procurement.call_finished", { marketRevision, disposition });
      return { ...objectResult(result), terminal: true, scripted_message_dispatched: true };
    }

    if (name === "request_human_escalation") {
      const reason = z.string().min(1).parse(args.reason);
      const unidentified = !call.operationId && !this.procurement?.getProfile(call.id);
      const latestTranscript = this.latestCarrierTurns.get(call.id)?.transcript ?? "";
      if (unidentified
        && (this.identificationFailures.get(call.id) ?? 0) < 3
        && !explicitlyRequestsHuman(latestTranscript)) {
        this.store.appendEvent(call.id, "escalation.denied_during_identification", {
          reason,
          identificationFailures: this.identificationFailures.get(call.id) ?? 0,
        });
        return {
          ok: false,
          escalated: false,
          error: "identification_incomplete",
          instruction: "Do not mention a human. Call identify_operation with the stated order reference, or ask only its suggested follow-up question.",
        };
      }
      // The escalation is a policy decision, and it succeeds the moment the
      // server records it: the lane is paused and the market moves to human
      // review whether or not a live transfer is possible. Only the delivery
      // mechanism can fail, and it always has a fallback, because the one
      // outcome that must never happen is a counterparty left on an open line
      // with an agent that has no remaining authority.
      const procurement = this.procurement?.markHumanRequired(call.id, reason);
      if (procurement) await this.propagateProcurementUpdates(procurement.controlUpdates);
      const marketRevision = procurementRevision(procurement?.result);
      const target = this.options.humanEscalationUri;

      if (call.realtimeCallId && target) {
        try {
          await this.realtime.transfer(call.realtimeCallId, target);
          this.store.updateCall(call.id, { status: "transferred", endedAt: new Date().toISOString() });
          this.store.appendEvent(call.id, "escalation.transferred", { reason, target });
          this.releaseCallSession(call.id);
          return { ok: true, escalated: true, transferred: true, marketRevision };
        } catch (error) {
          // A refer that fails mid-call is exactly when the fallback matters.
          this.store.appendEvent(call.id, "escalation.transfer_failed", {
            reason, target, error: errorMessage(error),
          });
        }
      } else {
        this.store.appendEvent(call.id, "escalation.no_transfer_target", { reason });
      }

      this.store.appendEvent(call.id, "escalation.callback_promised", { reason });
      return {
        ok: true,
        escalated: true,
        transferred: false,
        handoff: "CALLBACK",
        marketRevision,
        say: HUMAN_CALLBACK_CLOSING,
        instruction: procurement
          ? `Say the 'say' line verbatim, then call finish_procurement_call with marketRevision ${marketRevision ?? "from get_procurement_instruction"} and disposition HUMAN. Do not answer further questions and do not resume negotiating.`
          : "Say the 'say' line verbatim, then stop. Do not answer further questions and do not resume negotiating.",
      };
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

  private async propagateProcurementUpdates(updates: ProcurementControlUpdate[]): Promise<void> {
    for (const update of updates) {
      if (update.closingMessage) {
        await this.dispatchScriptedClosing(update.callId, update.closingMessage);
        continue;
      }
      const session = this.sessions.get(update.callId);
      if (!session) continue;
      session.injectContext(update.instruction);
      if (update.requestResponse) session.requestResponse();
      this.store.appendEvent(update.callId, "procurement.market_instruction_updated", { instruction: update.instruction });
    }
  }

  private async dispatchScriptedClosing(callId: string, message: string): Promise<boolean> {
    const call = this.requireCall(callId);
    if (!call.providerCallId) {
      this.store.appendEvent(call.id, "procurement.scripted_closing_failed", { error: "provider_call_id_missing" });
      return false;
    }
    try {
      await this.telephony.playMessageAndHangup(call.providerCallId, message);
      this.store.appendEvent(call.id, "procurement.scripted_closing_dispatched", { message });
      this.releaseCallSession(call.id);
      return true;
    } catch (error) {
      this.store.appendEvent(call.id, "procurement.scripted_closing_failed", { error: errorMessage(error) });
      return false;
    }
  }

  private releaseCallSession(callId: string): void {
    this.sessions.get(callId)?.close();
    this.sessions.delete(callId);
    this.latestCarrierTurns.delete(callId);
    this.identificationFailures.delete(callId);
  }

  private failedIdentification(callId: string, result: Record<string, unknown>): Record<string, unknown> {
    const attempts = (this.identificationFailures.get(callId) ?? 0) + 1;
    this.identificationFailures.set(callId, attempts);
    return {
      ...result,
      ok: false,
      attempts,
      shouldEscalate: attempts >= 3,
      escalate: attempts >= 3,
    };
  }

  private async handleAwardClosing(callId: string, result: unknown): Promise<unknown> {
    const closing = awardClosing(result);
    if (!closing) return result;
    const dispatched = await this.dispatchScriptedClosing(callId, closing.closingMessage);
    return {
      ...closing.result,
      scripted_message_dispatched: dispatched,
      ...(dispatched ? {} : {
        terminal: false,
        message: "The scripted phone redirect failed. Read closing_message verbatim, ask no further questions, then finish the call.",
      }),
    };
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

function nullableAgentString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function awardClosing(value: unknown): { result: Record<string, unknown>; closingMessage: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.terminal !== true || typeof result.closing_message !== "string" || !result.closing_message.trim()) return null;
  return { result, closingMessage: result.closing_message };
}

function objectResult(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function closingMessageFrom(value: unknown): string | null {
  const message = objectResult(value).closing_message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function carrierTurnEvidence(
  type: string,
  payload: unknown,
): { itemId: string | null; transcript: string } | null {
  if (type !== "transcript.turn" || !payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidate = payload as { itemId?: unknown; transcript?: unknown };
  if (typeof candidate.transcript !== "string" || !candidate.transcript.trim()) return null;
  return {
    itemId: typeof candidate.itemId === "string" && candidate.itemId.trim() ? candidate.itemId : null,
    transcript: candidate.transcript.trim(),
  };
}

function explicitlyRequestsHuman(transcript: string): boolean {
  const normalized = transcript.toLowerCase();
  const person = /\b(human|person|representative|operator|supervisor|humano|persona|asesor|operador|supervisor)\b/u.test(normalized);
  const request = /\b(speak|talk|connect|transfer|want|need|hablar|comunica|comunicar|pasa|pasar|quiero|necesito)\b/u.test(normalized);
  return person && request;
}

/** The market revision a procurement escalation left behind, when there is one. */
function procurementRevision(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const revision = (result as { market_revision?: unknown }).market_revision;
  return typeof revision === "number" ? revision : null;
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
