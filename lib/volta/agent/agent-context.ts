/**
 * What the agent is allowed to do on a call. The kind is derived from server
 * state only -- never from anything the counterparty says on the phone -- and
 * it decides which tools are even exposed to the model.
 */
export type VoltaCallKind =
  /** No operation is attached yet: restricted intake, identification only. */
  | "intake"
  /** An operation call outside a carrier market. */
  | "direct"
  /** A carrier-market call that may only collect a quote. */
  | "carrier_quote"
  /** A call participating in the dashboard's shared procurement market. */
  | "procurement"
  /** A booked carrier proposing a price or timing change to an active commitment. */
  | "amendment"
  /** The read-back call with the carrier the policy already selected. */
  | "carrier_confirmation";

/**
 * The single boundary between the voice model and the deterministic policy
 * layer. Every tool the agent can reach goes through here, so no negotiation
 * outcome exists until VoiceControlService has validated it against the
 * mandate and the carrier market.
 */
export type AgentToolInvoker = (name: string, args: unknown) => Promise<unknown>;

/** The server-computed brief for one live call. */
export interface AgentCallProfile {
  kind: VoltaCallKind;
  instructions: string;
}

/** Passed to the RealtimeSession as its context and reachable from every tool. */
export interface VoltaAgentContext {
  callId: string;
  kind: VoltaCallKind;
  invokeTool: AgentToolInvoker;
}
