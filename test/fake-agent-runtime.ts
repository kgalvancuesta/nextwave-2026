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
    return {
      useProfile: async (next) => { this.profile = next; this.rebriefs.push(next.kind); },
      injectContext: (text) => { this.injected.push(text); },
      requestResponse: () => { this.responsesRequested += 1; },
      close: () => { this.sessionsClosed += 1; },
    };
  }

  async transfer(realtimeCallId: string, targetUri: string): Promise<void> {
    this.transfers.push({ realtimeCallId, targetUri });
  }

  async hangup(): Promise<void> {}
}
