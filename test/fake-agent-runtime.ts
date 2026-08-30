import type { AgentCallProfile, AgentToolInvoker } from "@/lib/volta/agent/agent-context";
import type { AgentCallSession, RealtimeAgentGateway } from "@/lib/volta/ports";

/**
 * Stands in for the Agents SDK runtime. It captures the brief the control
 * plane computed and the tool invoker it handed over, so a test can drive the
 * exact call path a live agent would take without opening a socket.
 */
export class FakeAgentRuntime implements RealtimeAgentGateway {
  profile: AgentCallProfile | undefined;
  invokeTool: AgentToolInvoker | undefined;
  readonly injected: string[] = [];
  readonly rebriefs: string[] = [];
  responsesRequested = 0;
  sessionsClosed = 0;
  readonly transfers: Array<{ realtimeCallId: string; targetUri: string }> = [];
  readonly toolInvokers = new Map<string, AgentToolInvoker>();
  readonly responsesRequestedByCall = new Map<string, number>();
  readonly injectedByCall = new Map<string, string[]>();
  private readonly auditByCall = new Map<string, (type: string, payload: unknown) => void>();

  async verifyWebhook(): Promise<unknown> {
    throw new Error("unused");
  }

  async startCall(input: {
    realtimeCallId: string;
    callId: string;
    profile: AgentCallProfile;
    invokeTool: AgentToolInvoker;
    onAudit: (type: string, payload: unknown) => void;
  }): Promise<AgentCallSession> {
    this.profile = input.profile;
    this.invokeTool = input.invokeTool;
    this.toolInvokers.set(input.callId, input.invokeTool);
    this.auditByCall.set(input.callId, input.onAudit);
    return {
      useProfile: async (next) => { this.profile = next; this.rebriefs.push(next.kind); },
      injectContext: (text) => {
        this.injected.push(text);
        this.injectedByCall.set(input.callId, [...(this.injectedByCall.get(input.callId) ?? []), text]);
      },
      requestResponse: () => {
        this.responsesRequested += 1;
        this.responsesRequestedByCall.set(input.callId, (this.responsesRequestedByCall.get(input.callId) ?? 0) + 1);
      },
      close: () => { this.sessionsClosed += 1; },
    };
  }

  async transfer(realtimeCallId: string, targetUri: string): Promise<void> {
    this.transfers.push({ realtimeCallId, targetUri });
  }

  async hangup(): Promise<void> {}

  emitCarrierTranscript(transcript: string, itemId = "item_test"): void {
    const latest = [...this.auditByCall.values()].at(-1);
    latest?.("transcript.turn", { itemId, transcript });
  }

  emitCarrierTranscriptFor(callId: string, transcript: string, itemId = "item_test"): void {
    this.auditByCall.get(callId)?.("transcript.turn", { itemId, transcript });
  }

  async invokeFor(callId: string, name: string, args: unknown): Promise<unknown> {
    const invoke = this.toolInvokers.get(callId);
    if (!invoke) throw new Error(`No tool invoker for ${callId}`);
    return invoke(name, args);
  }
}
