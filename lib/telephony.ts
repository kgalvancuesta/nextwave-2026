import "server-only";

import twilio from "twilio";
import type { TelephonyConfig } from "./config";
import { assertVoiceReady } from "./voice-readiness";

export interface CreateCallInput {
  to: string;
  internalCallId: string;
}

export interface CreateNotificationCallInput extends CreateCallInput {
  message: string;
}

export interface TelephonyProvider {
  createCall(input: CreateCallInput): Promise<{ callSid: string }>;
  createNotificationCall?(input: CreateNotificationCallInput): Promise<{ callSid: string }>;
  startRecording(callSid: string): Promise<{ recordingSid: string }>;
  playMessageAndHangup(callSid: string, message: string): Promise<void>;
}

export class TwilioTelephonyProvider implements TelephonyProvider {
  private readonly client: ReturnType<typeof twilio>;

  constructor(private readonly config: TelephonyConfig) {
    this.client = config.apiKeySid && config.apiKeySecret
      ? twilio(config.apiKeySid, config.apiKeySecret, { accountSid: config.accountSid })
      : twilio(config.accountSid, config.authToken!);
  }

  async createCall(input: CreateCallInput): Promise<{ callSid: string }> {
    await assertVoiceReady();
    const recordingUrl = `${this.config.publicBaseUrl}/api/twilio/recording`;
    const call = await this.client.calls.create({
      to: input.to,
      from: this.config.phoneNumber,
      url: `${this.config.publicBaseUrl}/api/twilio/voice/outbound?callId=${encodeURIComponent(input.internalCallId)}`,
      method: "POST",
      statusCallback: `${this.config.publicBaseUrl}/api/twilio/status?callId=${encodeURIComponent(input.internalCallId)}`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      timeout: 45,
      record: this.config.recordCalls,
      ...(this.config.recordCalls ? {
        recordingChannels: "dual",
        recordingTrack: "both",
        recordingStatusCallback: recordingUrl,
        recordingStatusCallbackMethod: "POST",
        recordingStatusCallbackEvent: ["in-progress", "completed", "absent"],
      } : {}),
    });
    return { callSid: call.sid };
  }

  async createNotificationCall(input: CreateNotificationCallInput): Promise<{ callSid: string }> {
    await assertVoiceReady();
    const response = new twilio.twiml.VoiceResponse();
    response.say({ voice: "alice" }, input.message);
    response.hangup();
    const call = await this.client.calls.create({
      to: input.to,
      from: this.config.phoneNumber,
      twiml: response.toString(),
      statusCallback: `${this.config.publicBaseUrl}/api/twilio/status?callId=${encodeURIComponent(input.internalCallId)}`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      timeout: 45,
    });
    return { callSid: call.sid };
  }

  async startRecording(callSid: string): Promise<{ recordingSid: string }> {
    const recording = await this.client.calls(callSid).recordings.create({
      recordingChannels: "dual",
      recordingTrack: "both",
      recordingStatusCallback: `${this.config.publicBaseUrl}/api/twilio/recording`,
      recordingStatusCallbackMethod: "POST",
      recordingStatusCallbackEvent: ["in-progress", "completed", "absent"],
    });
    return { recordingSid: recording.sid };
  }

  async playMessageAndHangup(callSid: string, message: string): Promise<void> {
    const response = new twilio.twiml.VoiceResponse();
    response.say({ voice: "alice" }, message);
    response.hangup();
    await this.client.calls(callSid).update({ twiml: response.toString() });
  }
}

export function describeTwilioError(error: unknown): { code: string | null; message: string } {
  const candidate = error as { code?: string | number; message?: string; status?: number };
  const code = candidate.code === undefined ? null : String(candidate.code);
  const technical = candidate.message || "Unknown Twilio error";
  const explanation = (() => {
    switch (code) {
      case "20003": return "Twilio authentication failed. Check the Account SID and Auth Token.";
      case "21211": return "Twilio rejected the destination as an invalid phone number.";
      case "21215": return "This destination is not allowed by the current Twilio account.";
      case "21408": return "Calling this country is disabled in Twilio geographic permissions.";
      case "21608": return "A Twilio trial account can call only verified recipient numbers.";
      default: return "Twilio could not initiate this call.";
    }
  })();
  return { code, message: `${explanation} ${technical}` };
}
