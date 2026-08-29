import { mapTwilioCallStatus } from "./call-status";
import type { MarketlineRepository } from "./repository";
import { describeTwilioError, type TelephonyProvider } from "./telephony";
import type { CallRecord, VoiceResponse } from "./types";
import type { VoiceSessionAdapter } from "./voice-session";

export async function initiateOutboundBatch(input: {
  contactIds: string[];
  fromNumber: string;
  repository: MarketlineRepository;
  provider: TelephonyProvider;
  context?: { orderId: string; marketId: string };
}): Promise<{ batchId: string; calls: CallRecord[] }> {
  const uniqueIds = [...new Set(input.contactIds)];
  if (uniqueIds.length < 1 || uniqueIds.length > 3 || uniqueIds.length !== input.contactIds.length) {
    throw new Error("Select between one and three unique contacts.");
  }
  const contacts = input.repository.getContacts(uniqueIds);
  if (contacts.length !== uniqueIds.length) throw new Error("One or more selected contacts no longer exist.");

  const batch = input.repository.createOutboundBatch(contacts, input.fromNumber, input.context);
  await Promise.allSettled(batch.calls.map(async (call) => {
    try {
      const result = await input.provider.createCall({ to: call.toNumber, internalCallId: call.id });
      input.repository.setOutboundCallInitiated(call.id, result.callSid);
    } catch (error) {
      const detail = describeTwilioError(error);
      input.repository.setOutboundCallFailed(call.id, detail.code, detail.message);
    }
  }));
  return { batchId: batch.batchId, calls: batch.calls.map((call) => input.repository.getCall(call.id)!) };
}

export async function handleInboundCall(input: {
  params: Record<string, string>;
  repository: MarketlineRepository;
  voiceSession: VoiceSessionAdapter;
  recordingEnabled: boolean;
}): Promise<{ call: CallRecord; response: VoiceResponse }> {
  const callSid = required(input.params, "CallSid");
  const fromNumber = required(input.params, "From");
  const toNumber = required(input.params, "To");
  const call = input.repository.upsertInboundCall({
    twilioCallSid: callSid,
    fromNumber,
    toNumber,
    status: mapTwilioCallStatus(input.params.CallStatus || "in-progress"),
    rawPayload: input.params,
  });
  const response = await input.voiceSession.handleInboundCall({
    callSid,
    direction: "INBOUND",
    fromNumber,
    toNumber,
    recordingEnabled: input.recordingEnabled,
  });
  return { call, response };
}

export async function handleOutboundAnswer(input: {
  params: Record<string, string>;
  repository: MarketlineRepository;
  voiceSession: VoiceSessionAdapter;
  recordingEnabled: boolean;
}): Promise<VoiceResponse> {
  const callSid = required(input.params, "CallSid");
  const fromNumber = required(input.params, "From");
  const toNumber = required(input.params, "To");
  const existing = input.repository.getCallByTwilioSid(callSid);
  if (existing) input.repository.updateCallStatus(callSid, "IN_PROGRESS", input.params);
  return input.voiceSession.handleOutboundCall({
    callSid,
    direction: "OUTBOUND",
    fromNumber,
    toNumber,
    recordingEnabled: input.recordingEnabled,
  });
}

export function handleStatusCallback(input: {
  params: Record<string, string>;
  repository: MarketlineRepository;
}): CallRecord {
  const callSid = required(input.params, "CallSid");
  const status = mapTwilioCallStatus(required(input.params, "CallStatus"));
  const duration = integerOrNull(input.params.CallDuration);
  const errorCode = input.params.ErrorCode || null;
  const errorMessage = input.params.ErrorMessage || (errorCode ? `Twilio error ${errorCode}` : null);
  return input.repository.updateCallStatus(callSid, status, input.params, {
    durationSeconds: duration,
    errorCode,
    errorMessage,
  });
}

export function handleRecordingCallback(input: {
  params: Record<string, string>;
  repository: MarketlineRepository;
}) {
  return input.repository.upsertRecording({
    twilioRecordingSid: required(input.params, "RecordingSid"),
    twilioCallSid: required(input.params, "CallSid"),
    status: required(input.params, "RecordingStatus"),
    recordingUrl: input.params.RecordingUrl || null,
    durationSeconds: integerOrNull(input.params.RecordingDuration),
    recordingStartTime: input.params.RecordingStartTime || null,
    rawPayload: input.params,
  });
}

function required(params: Record<string, string>, name: string): string {
  const value = params[name]?.trim();
  if (!value) throw new Error(`Twilio webhook omitted ${name}.`);
  return value;
}

function integerOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
