import { OpenAIRealtimeSIP, RealtimeSession, type RealtimeSessionOptions } from "@openai/agents-realtime";
import OpenAI from "openai";
import type { AgentCallProfile, AgentToolInvoker, VoltaAgentContext } from "./agent/agent-context";
import { voltaOutputGuardrails } from "./agent/agent-guardrails";
import { createVoltaAgent } from "./agent/volta-agent";
import type { AgentCallSession, RealtimeAgentGateway } from "./ports";

export interface OpenAiAgentsRuntimeOptions {
  apiKey: string | undefined;
  webhookSecret: string | undefined;
  model: string;
  voice: string;
}

const WORKFLOW_NAME = "volta-voice-operations";

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
      outputGuardrails: voltaOutputGuardrails(),
      workflowName: WORKFLOW_NAME,
      traceMetadata: { internal_call_id: input.callId, call_kind: input.profile.kind },
    };

    // Accept the SIP leg with exactly the session the sideband will attach to,
    // so the model can never answer with a broader tool surface than the one
    // this call kind allows.
    const acceptPayload = await OpenAIRealtimeSIP.buildInitialConfig<VoltaAgentContext>(agent, sessionOptions);
    await client.realtime.calls.accept(input.realtimeCallId, acceptPayload);

    const session = new RealtimeSession<VoltaAgentContext>(agent, {
      ...sessionOptions,
      transport: new OpenAIRealtimeSIP(),
    });
    wireAudit(session, input.onAudit);
    await session.connect({ apiKey, callId: input.realtimeCallId });

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
        session.transport.sendEvent({ type: "response.create" });
      },
      close() {
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
 * Everything the agent does that a human reviewer would need after the fact.
 * Tool arguments are not recorded here: the policy layer already persists the
 * validated payload together with its decision.
 */
function wireAudit(
  session: RealtimeSession<VoltaAgentContext>,
  onAudit: (type: string, payload: unknown) => void,
): void {
  session.on("agent_tool_start", (_context, _agent, agentTool) => {
    onAudit("agent.tool_started", { tool: agentTool.name });
  });
  session.on("agent_tool_end", (_context, _agent, agentTool, result) => {
    onAudit("agent.tool_completed", { tool: agentTool.name, result });
  });
  session.on("guardrail_tripped", (_context, _agent, error, details) => {
    onAudit("agent.guardrail_tripped", { itemId: details.itemId, message: error.message });
  });
  session.on("error", (error) => {
    onAudit("agent.error", { error: describe(error.error) });
  });
  session.on("transport_event", (event) => {
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      onAudit("transcript.turn", { itemId: event.item_id, transcript: event.transcript });
    }
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
