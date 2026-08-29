import type { AgentCallProfile, AgentToolInvoker } from "./agent/agent-context";
import type {
  CallPatch,
  CallEvent,
  CallRecord,
  CarrierMarket,
  CarrierMarketInput,
  CarrierMarketPatch,
  CarrierMarketSelection,
  CarrierQuote,
  CarrierQuoteInput,
  CommitmentProposal,
  CommitmentRecord,
  CommitmentStatus,
  CreateCallInput,
  MandateDecision,
  Operation,
  OperationInput,
} from "./models";

export interface StateStore {
  createOperation(input: OperationInput): Operation;
  getOperation(id: string): Operation | null;
  findOperationByReference(reference: string): Operation | null;
  getOperationSnapshot(id: string): {
    operation: Operation;
    calls: CallRecord[];
    commitments: CommitmentRecord[];
    events: CallEvent[];
    markets: CarrierMarket[];
    quotes: CarrierQuote[];
  } | null;
  createCarrierMarket(input: CarrierMarketInput): CarrierMarket;
  getCarrierMarket(id: string): CarrierMarket | null;
  listCarrierMarkets(operationId: string): CarrierMarket[];
  updateCarrierMarket(id: string, patch: CarrierMarketPatch): CarrierMarket;
  selectCarrierQuote(input: CarrierMarketSelection): CarrierMarket;
  createCarrierQuote(input: CarrierQuoteInput): CarrierQuote;
  getCarrierQuote(id: string): CarrierQuote | null;
  listCarrierQuotes(marketId: string): CarrierQuote[];
  createCall(input: CreateCallInput): CallRecord;
  getCall(id: string): CallRecord | null;
  findCallByRealtimeId(realtimeCallId: string): CallRecord | null;
  attachCallToOperation(callId: string, operationId: string): void;
  attachCallToMarket(callId: string, marketId: string): void;
  updateCall(id: string, patch: CallPatch): void;
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
  dial(input: { to: string; internalCallId: string; operationId: string }): Promise<{ providerCallId: string }>;
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

/** A live agent attached to one call. Owned by the process that accepted it. */
export interface AgentCallSession {
  /**
   * Re-brief the live agent after server state changed, for example once an
   * inbound caller identified their operation and the call earns a wider tool
   * surface. The voice is never changed mid-call.
   */
  useProfile(profile: AgentCallProfile): Promise<void>;
  /** Push a server-side fact into the live conversation without speaking for the agent. */
  injectContext(text: string): void;
  /** Ask the agent to take the next turn, for example the opening greeting. */
  requestResponse(): void;
  close(): void;
}

/**
 * The Realtime agent runtime. It accepts the SIP call with a server-computed
 * agent brief and attaches a sideband session, but it never decides anything:
 * tool calls are routed straight back through `invokeTool` into the
 * deterministic policy layer.
 */
export interface RealtimeAgentGateway {
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<unknown>;
  startCall(input: {
    realtimeCallId: string;
    callId: string;
    profile: AgentCallProfile;
    invokeTool: AgentToolInvoker;
    onAudit: (type: string, payload: unknown) => void;
  }): Promise<AgentCallSession>;
  transfer(realtimeCallId: string, targetUri: string): Promise<void>;
  hangup(realtimeCallId: string): Promise<void>;
}
