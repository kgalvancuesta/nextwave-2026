import { RealtimeAgent } from "@openai/agents-realtime";
import type { AgentCallProfile, VoltaAgentContext } from "./agent-context";
import { toolsForKind } from "./agent-tools";

/**
 * Builds the Realtime agent for a single call. The agent owns conversation and
 * tool plumbing only: instructions, the tool surface, and the guardrails all
 * come from server state computed before the call was accepted.
 */
export function createVoltaAgent(
  profile: AgentCallProfile,
  options: { voice?: string | undefined } = {},
): RealtimeAgent<VoltaAgentContext> {
  return new RealtimeAgent<VoltaAgentContext>({
    name: `volta-${profile.kind}`,
    instructions: profile.instructions,
    tools: toolsForKind(profile.kind),
    ...(options.voice ? { voice: options.voice } : {}),
  });
}
