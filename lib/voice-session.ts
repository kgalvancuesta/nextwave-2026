import "server-only";

import twilio from "twilio";
import { loadVoltaConfig } from "./config";
import type { CallContext, VoiceResponse } from "./types";
import { buildCorrelatedSipUri, escapeXml } from "./volta/sip";
import { getVoltaStore } from "./volta/store";

export interface VoiceSessionAdapter {
  handleInboundCall(context: CallContext): Promise<VoiceResponse>;
  handleOutboundCall(context: CallContext): Promise<VoiceResponse>;
}

/**
 * Interim greeting spoken to every inbound caller until the full voice agent is wired up.
 * Update this string to change what callers hear.
 */
export const INBOUND_INTERIM_MESSAGE =
  "Thank you for calling Nextwave. Our automated phone service is currently being set up. Please try again soon.";

export class PlaceholderVoiceSessionAdapter implements VoiceSessionAdapter {
  async handleInboundCall(context: CallContext): Promise<VoiceResponse> {
    return this.build(context, INBOUND_INTERIM_MESSAGE);
  }

  async handleOutboundCall(context: CallContext): Promise<VoiceResponse> {
    return this.build(
      context,
      "Hello. This is a Marketline telephony test call. The voice agent is not connected yet.",
    );
  }

  private build(context: CallContext, message: string): VoiceResponse {
    const response = new twilio.twiml.VoiceResponse();
    if (context.recordingEnabled) {
      response.say({ voice: "alice" }, "This call may be recorded for testing and quality purposes.");
    }
    response.say({ voice: "alice" }, message);
    response.pause({ length: 3 });
    response.hangup();
    return { contentType: "text/xml", body: response.toString() };
  }
}

/**
 * Bridges an answered phone leg into the OpenAI Realtime agent over SIP. The
 * operation and call IDs travel as SIP headers issued here, on the server, so
 * the agent learns which negotiation it is on from the control plane and never
 * from whoever is on the line.
 *
 * An uncorrelated leg is never bridged: with no ledger row there is nothing to
 * hold the agent's tool calls to, so the call is declined politely instead.
 */
export class SipBridgeVoiceSessionAdapter implements VoiceSessionAdapter {
  constructor(
    private readonly options: {
      sipUri: string;
      resolveOperationId: (internalCallId: string) => string | null;
    },
  ) {}

  async handleInboundCall(context: CallContext): Promise<VoiceResponse> {
    return this.bridge(context);
  }

  async handleOutboundCall(context: CallContext): Promise<VoiceResponse> {
    return this.bridge(context);
  }

  private bridge(context: CallContext): VoiceResponse {
    if (!context.internalCallId) {
      return decline(context, "This call could not be matched to an operation. Goodbye.");
    }

    const sipUri = buildCorrelatedSipUri({
      sipUri: this.options.sipUri,
      internalCallId: context.internalCallId,
      operationId: this.options.resolveOperationId(context.internalCallId),
    });

    const disclosure = context.recordingEnabled
      ? '<Say voice="alice">This call may be recorded for quality and compliance purposes.</Say>'
      : "";
    return {
      contentType: "text/xml",
      body: '<?xml version="1.0" encoding="UTF-8"?><Response>'
        + disclosure
        + `<Dial answerOnBridge="true"><Sip>${escapeXml(sipUri)}</Sip></Dial></Response>`,
    };
  }
}

function decline(context: CallContext, message: string): VoiceResponse {
  const response = new twilio.twiml.VoiceResponse();
  if (context.recordingEnabled) {
    response.say({ voice: "alice" }, "This call may be recorded for quality and compliance purposes.");
  }
  response.say({ voice: "alice" }, message);
  response.hangup();
  return { contentType: "text/xml", body: response.toString() };
}

export const placeholderVoiceSession = new PlaceholderVoiceSessionAdapter();

/**
 * The agent answers when it is configured; otherwise the telephony harness
 * keeps working with its own placeholder greeting.
 */
export function resolveVoiceSession(): VoiceSessionAdapter {
  try {
    const config = loadVoltaConfig();
    return new SipBridgeVoiceSessionAdapter({
      sipUri: config.sipUri,
      resolveOperationId: (internalCallId) => getVoltaStore().getCall(internalCallId)?.operationId ?? null,
    });
  } catch {
    return placeholderVoiceSession;
  }
}
