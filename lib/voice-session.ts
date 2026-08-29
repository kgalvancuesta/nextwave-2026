import "server-only";

import twilio from "twilio";
import type { CallContext, VoiceResponse } from "./types";

export interface VoiceSessionAdapter {
  handleInboundCall(context: CallContext): Promise<VoiceResponse>;
  handleOutboundCall(context: CallContext): Promise<VoiceResponse>;
}

export class PlaceholderVoiceSessionAdapter implements VoiceSessionAdapter {
  async handleInboundCall(context: CallContext): Promise<VoiceResponse> {
    return this.build(
      context,
      "You have reached Marketline. Incoming calling is connected. The voice agent is not connected yet.",
    );
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

export const placeholderVoiceSession = new PlaceholderVoiceSessionAdapter();
