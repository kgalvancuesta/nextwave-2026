import type {
  CallEvent,
  CallRecord,
  CommitmentProposal,
  CommitmentRecord,
  CommitmentStatus,
  MandateDecision,
  Operation,
  OperationInput,
} from "./domain/models.js";

export interface StateStore {
  createOperation(input: OperationInput): Operation;
  getOperation(id: string): Operation | null;
  findOperationByReference(reference: string): Operation | null;
  getOperationSnapshot(id: string): {
    operation: Operation;
    calls: CallRecord[];
    commitments: CommitmentRecord[];
    events: CallEvent[];
  } | null;
  createCall(input: Omit<CallRecord, "id" | "startedAt" | "endedAt">): CallRecord;
  getCall(id: string): CallRecord | null;
  findCallByRealtimeId(realtimeCallId: string): CallRecord | null;
  attachCallToOperation(callId: string, operationId: string): void;
  updateCall(id: string, patch: Partial<Pick<CallRecord, "status" | "providerCallId" | "realtimeCallId" | "endedAt">>): void;
  appendEvent(callId: string, type: string, payload: unknown): CallEvent;
  createCommitment(input: {
    operationId: string;
    callId: string;
    proposal: CommitmentProposal;
    decision: MandateDecision;
  }): CommitmentRecord;
  listPendingCommitments(callId: string): CommitmentRecord[];
  updateCommitment(id: string, status: CommitmentStatus, recapDeliveryId?: string): void;
}

export interface OutboundTelephonyGateway {
  dial(input: { to: string; internalCallId: string; operationId: string; sipUri: string }): Promise<{ providerCallId: string }>;
}

export interface RecapGateway {
  deliver(input: {
    channel: "sms" | "email";
    address: string;
    commitmentId: string;
    operationReference: string;
    summary: string;
  }): Promise<{ deliveryId: string }>;
}

export interface RealtimeSession {
  send(event: unknown): void;
  close(): void;
}

export interface RealtimeGateway {
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<unknown>;
  acceptCall(input: { callId: string; instructions: string }): Promise<void>;
  connectSideband(callId: string, onEvent: (event: unknown) => Promise<void>): RealtimeSession;
  transfer(callId: string, targetUri: string): Promise<void>;
  hangup(callId: string): Promise<void>;
}
