import type { RealtimeOutputGuardrail } from "@openai/agents-realtime";
import type { VoltaAgentContext } from "./agent-context";

/**
 * Phrases that assert a booking exists. They are only a violation before the
 * deterministic layer has approved a commitment, which is every call except the
 * confirmation read-back.
 */
const BOOKING_CLAIM = new RegExp([
  "you'?re booked",
  "it'?s (confirmed|booked|a deal)",
  "consider it (booked|done)",
  "we have a deal",
  "queda (confirmado|reservado)",
  "est[aá] (confirmado|reservado|apartado)",
  "ya (lo )?reserv",
  "trato hecho",
].join("|"), "i");

/** Anything that leaks the harness or the buy-side position to the carrier. */
const INTERNAL_DISCLOSURE = new RegExp([
  "system prompt",
  "my (instructions|mandate|policy)",
  "policy (engine|harness)",
  "mi mandato",
  "mis instrucciones",
  "el sistema me (dice|indica|permite)",
  "(nuestro|el) presupuesto (m[aá]ximo|es)",
  "puedo pagar hasta",
  "(i can|we can) (pay|go) up to",
].join("|"), "i");

/**
 * Output guardrails run on the agent's own transcript while it speaks, so a
 * violation is caught in-call rather than in a post-mortem. They are a second
 * line of defence: the tool surface and the mandate checks remain the primary
 * controls.
 */
export function voltaOutputGuardrails(): RealtimeOutputGuardrail[] {
  return [
    {
      name: "no_unapproved_booking_claim",
      policyHint: "You claimed a booking exists. Only propose_commitment can approve one. Correct yourself: the offer is still being evaluated.",
      async execute({ agentOutput, context }) {
        const kind = (context.context as Partial<VoltaAgentContext>).kind;
        const triggered = kind !== "carrier_confirmation" && BOOKING_CLAIM.test(String(agentOutput));
        return { tripwireTriggered: triggered, outputInfo: { kind: kind ?? null } };
      },
    },
    {
      name: "no_internal_disclosure",
      policyHint: "You revealed internal system details or the buy-side budget. Never mention them; restate the commercial question instead.",
      async execute({ agentOutput }) {
        return {
          tripwireTriggered: INTERNAL_DISCLOSURE.test(String(agentOutput)),
          outputInfo: {},
        };
      },
    },
  ];
}
