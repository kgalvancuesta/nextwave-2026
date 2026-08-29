import { RunContext } from "@openai/agents";
import { describe, expect, it } from "vitest";
import type { VoltaAgentContext, VoltaCallKind } from "@/lib/volta/agent/agent-context";
import { voltaOutputGuardrails } from "@/lib/volta/agent/agent-guardrails";
import { toolsForKind } from "@/lib/volta/agent/agent-tools";
import { buildAgentProfile } from "@/lib/volta/agent/instructions";
import { createVoltaAgent } from "@/lib/volta/agent/volta-agent";
import type { CarrierMarket, CarrierQuote, OperationInput } from "@/lib/volta/models";

const operation: OperationInput = {
  externalReference: "CONT-42",
  objective: "Recover delayed Manzanillo pickup before free time expires",
  minimumCarrierCalls: 3,
  mandate: {
    currency: "MXN",
    rate: { min: 0, max: 9000 },
    pickupWindow: { earliest: "2026-09-03T10:00:00.000Z", latest: "2026-09-03T16:00:00.000Z" },
    allowedAccessorials: [],
    prohibitedTerms: ["pago en efectivo"],
  },
};

const market: CarrierMarket = {
  id: "market_1",
  operationId: "operation_1",
  candidates: [
    { name: "Transportes Pacifico", phone: "+12025550128", reliabilityScore: 87 },
    { name: "Drayage Occidente", phone: "+12025550129", reliabilityScore: 92 },
  ],
  status: "selected",
  selectedQuoteId: "quote_1",
  createdAt: "2026-09-03T09:00:00.000Z",
  closedAt: null,
};

const selectedQuote: CarrierQuote = {
  id: "quote_1",
  marketId: market.id,
  callId: "call_1",
  carrier: { name: "Drayage Occidente", phone: "+12025550129", reliabilityScore: 92 },
  terms: {
    summary: "MXN 8,200 pickup 11:00Z",
    rate: { amount: 8200, currency: "MXN" },
    pickupWindow: { start: "2026-09-03T11:00:00.000Z", end: "2026-09-03T13:00:00.000Z" },
    accessorials: [],
    terms: [],
    audioEvidence: { conversationItemId: "item_9", recordingId: "rec_9", startMs: 4_000, endMs: 9_000 },
  },
  mandateDecision: { allowed: true, violations: [] },
  createdAt: "2026-09-03T09:20:00.000Z",
};

const quoteArguments = {
  summary: "MXN 8,200 pickup 11:00Z",
  rate: { amount: 8200, currency: "MXN" },
  pickupWindow: { start: "2026-09-03T11:00:00.000Z", end: "2026-09-03T13:00:00.000Z" },
  accessorials: [],
  terms: [],
  detentionMinutes: null,
  audioEvidence: { conversationItemId: "item_9", recordingId: "rec_9", startMs: 4_000, endMs: 9_000 },
};

function toolNames(kind: VoltaCallKind): string[] {
  return toolsForKind(kind).map((agentTool) => agentTool.name).sort();
}

function contextFor(kind: VoltaCallKind, invokeTool: VoltaAgentContext["invokeTool"]) {
  return new RunContext<VoltaAgentContext & { history: [] }>({
    callId: "call_1",
    kind,
    invokeTool,
    history: [],
  });
}

describe("volta agent", () => {
  it("bounds each call kind by its tool surface, not by its prompt", () => {
    expect(toolNames("intake")).toEqual([
      "identify_operation",
      "record_brief_item",
      "request_human_escalation",
    ]);
    expect(toolNames("carrier_quote")).toEqual([
      "record_brief_item",
      "record_carrier_quote",
      "request_human_escalation",
    ]);
    expect(toolNames("carrier_confirmation")).toEqual([
      "propose_commitment",
      "record_brief_item",
      "request_human_escalation",
    ]);
    // A quote call cannot book, and an unidentified caller cannot do commerce.
    expect(toolNames("carrier_quote")).not.toContain("propose_commitment");
    expect(toolNames("intake")).not.toContain("record_carrier_quote");
    expect(toolNames("intake")).not.toContain("propose_commitment");
  });

  it("builds a realtime agent with a strict schema for the quote tool", () => {
    const agent = createVoltaAgent({ kind: "carrier_quote", instructions: "brief" }, { voice: "marin" });
    expect(agent.name).toBe("volta-carrier_quote");
    expect(agent.voice).toBe("marin");

    const quoteTool = agent.tools.find((agentTool) => agentTool.name === "record_carrier_quote");
    expect(quoteTool?.type).toBe("function");
  });

  it("routes a tool call to the deterministic layer and returns its verdict verbatim", async () => {
    const received: Array<{ name: string; args: unknown }> = [];
    const quoteTool = toolsForKind("carrier_quote").find((agentTool) => agentTool.name === "record_carrier_quote");
    expect(quoteTool).toBeDefined();

    const output = await quoteTool?.invoke(
      contextFor("carrier_quote", async (name, args) => {
        received.push({ name, args });
        return { ok: true, quote_id: "quote_1", eligible_within_mandate: true };
      }),
      JSON.stringify(quoteArguments),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.name).toBe("record_carrier_quote");
    // A null optional stays out of the domain payload instead of failing its schema.
    expect(Object.hasOwn(received[0]?.args as object, "detentionMinutes")).toBe(false);
    expect(JSON.parse(String(output))).toEqual({
      ok: true,
      quote_id: "quote_1",
      eligible_within_mandate: true,
    });
  });

  it("returns a rejected tool call as a structured refusal instead of a crash", async () => {
    const quoteTool = toolsForKind("carrier_quote").find((agentTool) => agentTool.name === "record_carrier_quote");

    const output = await quoteTool?.invoke(
      contextFor("carrier_quote", async () => {
        throw new Error("Call is not part of a carrier market");
      }),
      JSON.stringify(quoteArguments),
    );

    expect(JSON.parse(String(output))).toEqual({
      ok: false,
      error: "Call is not part of a carrier market",
      escalate: true,
    });
  });

  it("catches a booking claim made before a commitment exists", async () => {
    const agent = createVoltaAgent({ kind: "carrier_quote", instructions: "brief" });
    const bookingGuardrail = voltaOutputGuardrails()[0];
    expect(bookingGuardrail).toBeDefined();

    const duringQuoting = await bookingGuardrail?.execute({
      agent,
      agentOutput: "Perfecto, queda confirmado el servicio para el jueves.",
      context: contextFor("carrier_quote", async () => ({})),
    });
    expect(duringQuoting?.tripwireTriggered).toBe(true);

    const duringConfirmation = await bookingGuardrail?.execute({
      agent,
      agentOutput: "Perfecto, queda confirmado el servicio para el jueves.",
      context: contextFor("carrier_confirmation", async () => ({})),
    });
    expect(duringConfirmation?.tripwireTriggered).toBe(false);

    const neutral = await bookingGuardrail?.execute({
      agent,
      agentOutput: "Gracias, registro su tarifa y le confirmamos mas tarde.",
      context: contextFor("carrier_quote", async () => ({})),
    });
    expect(neutral?.tripwireTriggered).toBe(false);
  });

  it("derives the brief from server state, including who won the market", () => {
    const intake = buildAgentProfile({
      call: { counterparty: "+12025550135" },
      operation: null,
      market: null,
      selectedQuote: null,
    });
    expect(intake.kind).toBe("intake");
    expect(intake.instructions).toContain("Use identify_operation");
    expect(intake.instructions).not.toContain("Mandate JSON");

    const winner = buildAgentProfile({
      call: { counterparty: "Drayage Occidente" },
      operation,
      market,
      selectedQuote,
    });
    expect(winner.kind).toBe("carrier_confirmation");
    expect(winner.instructions).toContain(JSON.stringify(selectedQuote.terms));

    const loser = buildAgentProfile({
      call: { counterparty: "Transportes Pacifico" },
      operation,
      market,
      selectedQuote,
    });
    expect(loser.kind).toBe("carrier_quote");
    expect(loser.instructions).not.toContain(JSON.stringify(selectedQuote.terms));
  });
});
