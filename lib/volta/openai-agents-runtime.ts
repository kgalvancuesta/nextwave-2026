import { OpenAIRealtimeSIP, RealtimeSession, type RealtimeSessionOptions } from "@openai/agents-realtime";
import OpenAI from "openai";
import type { AgentCallProfile, AgentToolInvoker, VoltaAgentContext } from "./agent/agent-context";
import { voltaOutputGuardrails } from "./agent/agent-guardrails";
import { createVoltaAgent } from "./agent/volta-agent";
import type { AgentCallSession, RealtimeAgentGateway } from "./ports";
import { voiceError, voiceLog } from "@/lib/voice-log";

export interface OpenAiAgentsRuntimeOptions {
  apiKey: string | undefined;
  webhookSecret: string | undefined;
  model: string;
  transcriptionModel: string;
  voice: string;
}

const WORKFLOW_NAME = "volta-voice-operations";

export const REALTIME_INPUT_AUDIO_CONFIG = {
  noiseReduction: { type: "far_field" as const },
  transcription: {
    model: "gpt-transcribe" as const,
    languages: ["en", "es"],
    keywords: [
      "MXN", "pesos", "pickup", "recoleccion", "arrival", "delivery",
      "entrega", "all-in", "todo incluido",
    ],
    prompt: "Ground-transport carrier quote. Preserve every price, currency, date, clock time, AM/PM marker, and pickup-versus-delivery term exactly.",
  },
  turnDetection: {
    // SIP call acceptance rejects custom VAD thresholds/timers. Default
    // server VAD gives telephone turns a deterministic silence boundary;
    // low-eagerness semantic VAD can hold noisy phone audio open too long.
    type: "server_vad" as const,
    createResponse: true,
    interruptResponse: true,
  },
};

/**
 * Runs the Volta agent on OpenAI's Agents SDK over a SIP-initiated Realtime
 * call. The SDK owns the socket, the tool-call protocol, and the guardrail
 * loop; this adapter owns correlation and the audit trail. Policy stays in
 * VoiceControlService, which is reached only through `invokeTool`.
 */
export class OpenAiAgentsRuntime implements RealtimeAgentGateway {
  private readonly client: OpenAI | null;

  constructor(private readonly options: OpenAiAgentsRuntimeOptions) {
    this.client = options.apiKey
      ? new OpenAI({ apiKey: options.apiKey, webhookSecret: options.webhookSecret })
      : null;
  }

  async verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<unknown> {
    const client = this.requireClient();
    if (!this.options.webhookSecret) throw new Error("OPENAI_WEBHOOK_SECRET is not configured");
    return client.webhooks.unwrap(rawBody, headers, this.options.webhookSecret);
  }

  async startCall(input: {
    realtimeCallId: string;
    callId: string;
    profile: AgentCallProfile;
    invokeTool: AgentToolInvoker;
    onAudit: (type: string, payload: unknown) => void;
  }): Promise<AgentCallSession> {
    voiceLog("info", "realtime.start_requested", {
      callId: input.callId,
      realtimeCallId: input.realtimeCallId,
      agentKind: input.profile.kind,
      model: this.options.model,
      transcriptionModel: this.options.transcriptionModel,
      voice: this.options.voice,
    });
    const client = this.requireClient();
    const apiKey = this.requireApiKey();
    const agent = createVoltaAgent(input.profile, { voice: this.options.voice });
    const context: VoltaAgentContext = {
      callId: input.callId,
      kind: input.profile.kind,
      invokeTool: input.invokeTool,
    };
    const sessionOptions: Partial<RealtimeSessionOptions<VoltaAgentContext>> = {
      apiKey,
      model: this.options.model,
      context,
      config: {
        reasoning: { effort: "low" },
        audio: {
          input: {
            ...REALTIME_INPUT_AUDIO_CONFIG,
            transcription: {
              ...REALTIME_INPUT_AUDIO_CONFIG.transcription,
              model: this.options.transcriptionModel,
            },
          },
        },
      },
      outputGuardrails: voltaOutputGuardrails(),
      workflowName: WORKFLOW_NAME,
      traceMetadata: { internal_call_id: input.callId, call_kind: input.profile.kind },
    };

    // Accept the SIP leg with exactly the session the sideband will attach to,
    // so the model can never answer with a broader tool surface than the one
    // this call kind allows.
    const acceptPayload = await OpenAIRealtimeSIP.buildInitialConfig<VoltaAgentContext>(agent, sessionOptions);
    voiceLog("info", "realtime.accept_requested", {
      callId: input.callId,
      realtimeCallId: input.realtimeCallId,
      agentKind: input.profile.kind,
      inputTranscription: this.options.transcriptionModel,
      turnDetection: REALTIME_INPUT_AUDIO_CONFIG.turnDetection.type,
    });
    try {
      await client.realtime.calls.accept(input.realtimeCallId, acceptPayload);
      voiceLog("info", "realtime.accept_succeeded", { callId: input.callId, realtimeCallId: input.realtimeCallId });
    } catch (error) {
      voiceLog("error", "realtime.accept_failed", { callId: input.callId, realtimeCallId: input.realtimeCallId, error: voiceError(error) });
      throw error;
    }

    const session = new RealtimeSession<VoltaAgentContext>(agent, {
      ...sessionOptions,
      transport: new OpenAIRealtimeSIP(),
    });
    const opening = new OpeningResponseCoordinator(() => {
      if (session.transport.requestResponse) session.transport.requestResponse();
      else session.transport.sendEvent({ type: "response.create" });
    });
    wireOpeningResponse(session, opening);
    wireAudit(session, input.callId, input.onAudit);
    voiceLog("info", "realtime.sideband_connecting", { callId: input.callId, realtimeCallId: input.realtimeCallId });
    try {
      await session.connect({ apiKey, callId: input.realtimeCallId });
      voiceLog("info", "realtime.sideband_connected", { callId: input.callId, realtimeCallId: input.realtimeCallId });
    } catch (error) {
      voiceLog("error", "realtime.sideband_failed", { callId: input.callId, realtimeCallId: input.realtimeCallId, error: voiceError(error) });
      throw error;
    }

    return {
      async useProfile(next: AgentCallProfile) {
        await session.updateAgent(createVoltaAgent(next));
      },
      injectContext(text: string) {
        session.transport.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: `Background control update: ${text}` }],
          },
        });
      },
      requestResponse() {
        opening.request();
      },
      close() {
        opening.close();
        session.close();
      },
    };
  }

  async transfer(realtimeCallId: string, targetUri: string): Promise<void> {
    await this.requireClient().realtime.calls.refer(realtimeCallId, { target_uri: targetUri });
  }

  async hangup(realtimeCallId: string): Promise<void> {
    await this.requireClient().realtime.calls.hangup(realtimeCallId);
  }

  private requireClient(): OpenAI {
    if (!this.client) throw new Error("OPENAI_API_KEY is not configured");
    return this.client;
  }

  private requireApiKey(): string {
    if (!this.options.apiKey) throw new Error("OPENAI_API_KEY is not configured");
    return this.options.apiKey;
  }
}

/**
 * Starts an outbound greeting only when the remote leg is quiet. Carrier
 * greetings and voicemail often begin while the SIP sideband is connecting;
 * sending response.create immediately in that window causes the opening to be
 * interrupted before any audio is heard. Server VAD can answer first, while
 * this coordinator supplies a bounded fallback when it does not.
 */
export class OpeningResponseCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private remoteSpeaking = false;
  private responseActive = false;
  private requestPending = false;
  private openingComplete = false;
  private closed = false;

  constructor(
    private readonly sendResponse: () => void,
    private readonly quietDelayMs = 750,
  ) {}

  request(): void {
    if (this.closed) return;
    if (this.openingComplete) {
      this.sendResponse();
      return;
    }
    this.schedule();
  }

  onRemoteSpeechStarted(): void {
    this.remoteSpeaking = true;
    this.clearTimer();
  }

  onRemoteSpeechStopped(): void {
    this.remoteSpeaking = false;
    this.schedule();
  }

  onResponseCreated(): void {
    this.requestPending = false;
    this.responseActive = true;
    this.clearTimer();
  }

  onResponseDone(): void {
    this.requestPending = false;
    this.responseActive = false;
    this.schedule();
  }

  onAudioStopped(): void {
    this.openingComplete = true;
    this.requestPending = false;
    this.responseActive = false;
    this.clearTimer();
  }

  onAudioInterrupted(): void {
    this.openingComplete = false;
  }

  close(): void {
    this.closed = true;
    this.clearTimer();
  }

  private schedule(): void {
    if (this.closed || this.openingComplete || this.remoteSpeaking || this.responseActive || this.requestPending || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.closed || this.openingComplete || this.remoteSpeaking || this.responseActive || this.requestPending) return;
      this.requestPending = true;
      this.sendResponse();
    }, this.quietDelayMs);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

function wireOpeningResponse(
  session: RealtimeSession<VoltaAgentContext>,
  opening: OpeningResponseCoordinator,
): void {
  session.on("audio_stopped", () => opening.onAudioStopped());
  session.on("audio_interrupted", () => opening.onAudioInterrupted());
  session.on("transport_event", (event) => {
    if (event.type === "input_audio_buffer.speech_started") opening.onRemoteSpeechStarted();
    else if (event.type === "input_audio_buffer.speech_stopped") opening.onRemoteSpeechStopped();
    else if (event.type === "response.created") opening.onResponseCreated();
    else if (event.type === "response.done") opening.onResponseDone();
  });
}

/**
 * Everything the agent does that a human reviewer would need after the fact.
 * Validated tool payloads are persisted by the policy layer with its decision;
 * only the raw argument string is captured here, from the transport event, so
 * a call the SDK rejected before execution is still reviewable.
 */
function wireAudit(
  session: RealtimeSession<VoltaAgentContext>,
  callId: string,
  onAudit: (type: string, payload: unknown) => void,
): void {
  session.on("agent_tool_start", (_context, _agent, agentTool) => {
    onAudit("agent.tool_started", { tool: agentTool.name });
  });
  session.on("agent_tool_end", (_context, _agent, agentTool, result) => {
    onAudit("agent.tool_completed", { tool: agentTool.name, result });
  });
  session.on("agent_end", (_context, _agent, output) => {
    onAudit("agent.turn_completed", { transcript: output });
  });
  session.on("audio_start", () => onAudit("agent.audio_started", {}));
  session.on("audio_stopped", () => onAudit("agent.audio_stopped", {}));
  session.on("audio_interrupted", () => onAudit("agent.audio_interrupted", {}));
  session.on("guardrail_tripped", (_context, _agent, error, details) => {
    onAudit("agent.guardrail_tripped", { itemId: details.itemId, message: error.message });
  });
  session.on("error", (error) => {
    onAudit("agent.error", { error: describe(error.error) });
  });
  session.on("transport_event", (event) => {
    voiceLog(event.type === "error" || event.type.endsWith(".failed") ? "error" : "info", "realtime.server_event", {
      callId,
      ...summarizeRealtimeEvent(event as unknown as Record<string, unknown>),
    });
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      onAudit("transcript.turn", { itemId: event.item_id, transcript: event.transcript });
    } else if (event.type === "conversation.item.input_audio_transcription.failed") {
      onAudit("transcript.failed", { itemId: event.item_id, error: event.error });
    } else if (event.type === "response.output_audio_transcript.done") {
      onAudit("transcript.assistant", {
        itemId: event.item_id,
        responseId: event.response_id,
        transcript: event.transcript,
      });
    } else if (event.type === "response.function_call_arguments.done") {
      // The raw argument string is the only evidence left when the SDK rejects
      // a call as invalid JSON before any tool code runs.
      onAudit("agent.tool_arguments", {
        itemId: event.item_id,
        toolCallId: event.call_id,
        tool: event.name,
        arguments: event.arguments,
      });
    } else if (event.type === "input_audio_buffer.speech_started") {
      onAudit("audio.input_started", { itemId: event.item_id, audioStartMs: event.audio_start_ms });
    } else if (event.type === "input_audio_buffer.speech_stopped") {
      onAudit("audio.input_stopped", { itemId: event.item_id, audioEndMs: event.audio_end_ms });
    } else if (event.type === "response.done") {
      onAudit("agent.response_done", {
        responseId: event.response.id ?? null,
        status: event.response.status ?? null,
        statusDetails: event.response.status_details ?? null,
      });
    }
  });
}

function summarizeRealtimeEvent(event: Record<string, unknown>): Record<string, unknown> {
  const type = typeof event.type === "string" ? event.type : "unknown";
  const summary: Record<string, unknown> = { type };
  for (const key of ["event_id", "item_id", "response_id", "call_id", "name", "output_index", "content_index", "audio_start_ms", "audio_end_ms"]) {
    if (event[key] !== undefined) summary[key] = event[key];
  }
  if (typeof event.arguments === "string") summary.arguments = event.arguments;
  if (typeof event.transcript === "string") summary.transcript = event.transcript;
  if (typeof event.delta === "string") {
    summary.delta = type.includes("transcript") ? event.delta : `[OMITTED ${event.delta.length} chars]`;
  }
  if (event.error !== undefined) summary.error = event.error;
  if (event.response && typeof event.response === "object") {
    const response = event.response as Record<string, unknown>;
    summary.response = {
      id: response.id,
      status: response.status,
      status_details: response.status_details,
      usage: response.usage,
    };
  }
  return summary;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
