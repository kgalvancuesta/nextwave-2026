export const CALL_STATUSES = [
  "REQUESTED",
  "INITIATED",
  "RINGING",
  "IN_PROGRESS",
  "COMPLETED",
  "BUSY",
  "NO_ANSWER",
  "FAILED",
  "CANCELED",
] as const;

export type CallStatus = (typeof CALL_STATUSES)[number];
export type CallDirection = "INBOUND" | "OUTBOUND";

export interface Contact {
  id: string;
  label: string;
  phoneInput: string;
  e164PhoneNumber: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CallBatch {
  id: string;
  createdAt: string;
}

export interface CallRecord {
  id: string;
  twilioCallSid: string | null;
  batchId: string | null;
  contactId: string | null;
  contactLabel: string | null;
  orderId: string | null;
  marketId: string | null;
  carrierId: string | null;
  direction: CallDirection;
  fromNumber: string;
  toNumber: string;
  status: CallStatus;
  startedAt: string;
  answeredAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordingRecord {
  id: string;
  twilioRecordingSid: string;
  twilioCallSid: string;
  status: string;
  recordingUrl: string | null;
  durationSeconds: number | null;
  recordingStartTime: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CallContext {
  callSid: string;
  direction: CallDirection;
  fromNumber: string;
  toNumber: string;
  recordingEnabled: boolean;
}

export interface VoiceResponse {
  contentType: "text/xml";
  body: string;
}

/**
 * App-visible inbound call state. The backend derives this from active call records;
 * the frontend displays it without maintaining its own state machine.
 *
 * - idle:        no active inbound call
 * - incoming:    the number is ringing (Twilio status: ringing)
 * - in_progress: the call has been answered (Twilio status: in-progress)
 */
export type InboundCallState = "idle" | "incoming" | "in_progress";
