import OpenAI from "openai";
import WebSocket from "ws";
import type { RealtimeGateway, RealtimeSession } from "../ports.js";

interface OpenAiRealtimeOptions {
  apiKey: string | undefined;
  webhookSecret: string | undefined;
  model: string;
  voice: string;
}

const tools = [
  {
    type: "function",
    name: "identify_operation",
    description: "Attach an unassigned inbound call to an operation after the caller provides its reference.",
    parameters: {
      type: "object",
      properties: { external_reference: { type: "string" } },
      required: ["external_reference"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "propose_commitment",
    description: "Submit a verbally agreed commitment for deterministic mandate validation. Never claim it is final until this tool approves it.",
    parameters: {
      type: "object",
      properties: {
        counterparty: { type: "string" },
        summary: { type: "string" },
        rate: {
          type: "object",
          properties: { amount: { type: "number" }, currency: { type: "string" } },
          required: ["amount", "currency"],
          additionalProperties: false,
        },
        pickupWindow: {
          type: "object",
          properties: { start: { type: "string" }, end: { type: "string" } },
          required: ["start", "end"],
          additionalProperties: false,
        },
        accessorials: { type: "array", items: { type: "string" } },
        terms: { type: "array", items: { type: "string" } },
        detentionMinutes: { type: "number" },
        recapTarget: {
          type: "object",
          properties: { channel: { type: "string", enum: ["sms", "email"] }, address: { type: "string" } },
          required: ["channel", "address"],
          additionalProperties: false,
        },
        audioEvidence: {
          type: "object",
          description: "Exact range in the telephony recording where both parties agreed.",
          properties: {
            conversationItemId: { type: "string" },
            recordingId: { type: "string" },
            startMs: { type: "integer" },
            endMs: { type: "integer" },
          },
          required: ["conversationItemId", "recordingId", "startMs", "endMs"],
          additionalProperties: false,
        },
      },
      required: ["counterparty", "summary", "rate", "pickupWindow", "accessorials", "terms", "recapTarget", "audioEvidence"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "record_brief_item",
    description: "Record a relevant fact, quote, objection, identity claim, condition, or action in the call brief.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string" },
        detail: { type: "string" },
        conversation_item_id: { type: "string" },
      },
      required: ["category", "detail", "conversation_item_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "request_human_escalation",
    description: "Transfer the live call to a human when identity is uncertain, facts conflict, or a request exceeds the mandate.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
] as const;

export class OpenAiRealtimeGateway implements RealtimeGateway {
  private readonly client: OpenAI | null;

  constructor(private readonly options: OpenAiRealtimeOptions) {
    this.client = options.apiKey ? new OpenAI({ apiKey: options.apiKey, webhookSecret: options.webhookSecret }) : null;
  }

  async verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<unknown> {
    const client = this.requireClient();
    if (!this.options.webhookSecret) throw new Error("OPENAI_WEBHOOK_SECRET is not configured");
    return client.webhooks.unwrap(rawBody, headers, this.options.webhookSecret);
  }

  async acceptCall(input: { callId: string; instructions: string }): Promise<void> {
    await this.request(`/v1/realtime/calls/${encodeURIComponent(input.callId)}/accept`, {
      type: "realtime",
      model: this.options.model,
      instructions: input.instructions,
      output_modalities: ["audio"],
      audio: { output: { voice: this.options.voice } },
      tools,
      tool_choice: "auto",
      tracing: "auto",
    });
  }

  connectSideband(callId: string, onEvent: (event: unknown) => Promise<void>): RealtimeSession {
    if (!this.options.apiKey) throw new Error("OPENAI_API_KEY is not configured");
    const socket = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
      headers: { authorization: `Bearer ${this.options.apiKey}` },
    });
    socket.on("message", (data) => {
      void onEvent(JSON.parse(data.toString()) as unknown);
    });
    socket.on("error", (error) => {
      void onEvent({ type: "control_plane.sideband_error", error: error.message });
    });
    return {
      send(event: unknown) {
        const payload = JSON.stringify(event);
        if (socket.readyState === WebSocket.OPEN) socket.send(payload);
        else socket.once("open", () => socket.send(payload));
      },
      close() { socket.close(); },
    };
  }

  async transfer(callId: string, targetUri: string): Promise<void> {
    await this.request(`/v1/realtime/calls/${encodeURIComponent(callId)}/refer`, { target_uri: targetUri });
  }

  async hangup(callId: string): Promise<void> {
    await this.request(`/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`);
  }

  private async request(path: string, body?: unknown): Promise<void> {
    if (!this.options.apiKey) throw new Error("OPENAI_API_KEY is not configured");
    const response = await fetch(`https://api.openai.com${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenAI Realtime returned ${response.status}: ${detail}`);
    }
  }

  private requireClient(): OpenAI {
    if (!this.client) throw new Error("OPENAI_API_KEY is not configured");
    return this.client;
  }
}
