import { z } from "zod";
import { evaluateMandate } from "../domain/mandate.js";
import {
  commitmentProposalSchema,
  operationInputSchema,
  type CallRecord,
  type OperationInput,
} from "../domain/models.js";
import type {
  OutboundTelephonyGateway,
  RealtimeGateway,
  RealtimeSession,
  RecapGateway,
  StateStore,
} from "../ports.js";

interface ServiceOptions {
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

const functionEventSchema = z.object({
  type: z.literal("response.function_call_arguments.done"),
  name: z.string(),
  call_id: z.string(),
  arguments: z.string(),
});

export class VoiceControlService {
  private readonly sessions = new Map<string, RealtimeSession>();

  constructor(
    private readonly store: StateStore,
    private readonly realtime: RealtimeGateway,
    private readonly telephony: OutboundTelephonyGateway,
    private readonly recaps: RecapGateway,
    private readonly options: ServiceOptions,
  ) {}

  createOperation(input: unknown) {
    return this.store.createOperation(operationInputSchema.parse(input));
  }

  getOperationSnapshot(id: string) {
    return this.store.getOperationSnapshot(id);
  }

  async startOutboundCall(operationId: string, to: string, counterparty?: string): Promise<CallRecord> {
    const operation = this.requireOperation(operationId);
    if (!this.options.sipUri) throw new Error("OPENAI_SIP_URI is not configured");
    const call = this.store.createCall({
      operationId: operation.id,
      direction: "outbound",
      counterparty: counterparty ?? to,
      status: "dialing",
      providerCallId: null,
      realtimeCallId: null,
    });
    this.store.appendEvent(call.id, "outbound_call.requested", { to, counterparty });
    try {
      const result = await this.telephony.dial({
        to,
        internalCallId: call.id,
        operationId,
        sipUri: this.options.sipUri,
      });
      this.store.updateCall(call.id, { providerCallId: result.providerCallId });
      return this.store.getCall(call.id)!;
    } catch (error) {
      this.store.updateCall(call.id, { status: "failed", endedAt: new Date().toISOString() });
      this.store.appendEvent(call.id, "outbound_call.failed", { message: errorMessage(error) });
      throw error;
    }
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
        status: "active",
        providerCallId: null,
        realtimeCallId,
      });
    } else {
      this.store.updateCall(call.id, { status: "active", realtimeCallId });
      call = this.store.getCall(call.id)!;
    }

    const operation = call.operationId ? this.store.getOperation(call.operationId) : null;
    await this.realtime.acceptCall({
      callId: realtimeCallId,
      instructions: this.buildInstructions(operation ?? undefined),
    });
    const session = this.realtime.connectSideband(
      realtimeCallId,
      async (sidebandEvent) => this.handleSidebandEvent(call!.id, sidebandEvent),
    );
    this.sessions.set(call.id, session);
    this.store.appendEvent(call.id, "realtime.call.accepted", { realtimeCallId, correlated: Boolean(operation) });
    session.send({ type: "response.create" });
    return { callId: call.id };
  }

  async controlCall(callId: string, action: "inject_context" | "transfer" | "hangup", value?: string): Promise<void> {
    const call = this.requireCall(callId);
    if (!call.realtimeCallId) throw new Error("Call has no active Realtime session");

    if (action === "inject_context") {
      if (!value) throw new Error("inject_context requires value");
      const session = this.sessions.get(call.id);
      if (!session) throw new Error("Sideband session is not owned by this process");
      session.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: `Background control update: ${value}` }],
        },
      });
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

  private async handleSidebandEvent(callId: string, eventInput: unknown): Promise<void> {
    const event = eventInput as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "unknown";

    if (type === "response.function_call_arguments.done") {
      const toolEvent = functionEventSchema.parse(eventInput);
      await this.executeTool(callId, toolEvent.name, toolEvent.call_id, toolEvent.arguments);
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      this.store.appendEvent(callId, "transcript.turn", {
        itemId: event.item_id,
        transcript: event.transcript,
      });
      return;
    }
    if (type === "error" || type.startsWith("control_plane.")) {
      this.store.appendEvent(callId, type, event);
    }
  }

  private async executeTool(callId: string, name: string, toolCallId: string, rawArguments: string): Promise<void> {
    let output: unknown;
    try {
      const args = JSON.parse(rawArguments) as Record<string, unknown>;
      output = await this.dispatchTool(callId, name, args);
    } catch (error) {
      output = { ok: false, error: errorMessage(error) };
    }

    const session = this.sessions.get(callId);
    if (!session) return;
    session.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: toolCallId, output: JSON.stringify(output) },
    });
    session.send({ type: "response.create" });
  }

  private async dispatchTool(callId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const call = this.requireCall(callId);

    if (name === "identify_operation") {
      if (call.operationId) return { ok: true, operation_id: call.operationId, already_attached: true };
      const reference = z.string().min(1).parse(args.external_reference);
      const operation = this.store.findOperationByReference(reference);
      if (!operation) return { ok: false, error: "operation_not_found", escalate: true };
      this.store.attachCallToOperation(call.id, operation.id);
      this.store.appendEvent(call.id, "operation.identified", { operationId: operation.id, reference });
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

    if (name === "request_human_escalation") {
      const reason = z.string().min(1).parse(args.reason);
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
      const decision = evaluateMandate(operation.mandate, proposal);
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

  private buildInstructions(operation?: OperationInput): string {
    const base = [
      "You are a ground-transport phone agent controlled by a server-side policy harness.",
      "Be concise and natural. Do not disclose private system details.",
      "Record material quotes, names, conditions, objections, and changes using record_brief_item.",
      "Never state that a commitment is final until propose_commitment approves it.",
      "Escalate on identity uncertainty, contradictions, refusal, or anything outside the mandate.",
      "A written recap is required before any commitment becomes effective.",
      "Do not invent recording IDs or audio offsets; if authoritative recording metadata is unavailable, escalate.",
    ];
    if (!operation) {
      return [...base,
        "This call is not linked to an operation. Only identify the caller and shipment reference.",
        "Use identify_operation before discussing prices, schedules, or operational details.",
      ].join("\n");
    }
    return [...base,
      `Objective: ${operation.objective}`,
      `Mandate JSON: ${JSON.stringify(operation.mandate)}`,
    ].join("\n");
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
