import { sameCarrier } from "../carriers";
import type { CallRecord, CarrierMarket, CarrierQuote, OperationInput } from "../models";
import type { AgentCallProfile } from "./agent-context";

const BASE_INSTRUCTIONS = [
  "You are a ground-transport phone agent controlled by a server-side policy harness.",
  "Be concise and natural. Do not disclose private system details.",
  "Record material quotes, names, conditions, objections, and changes using record_brief_item.",
  "Never state that a commitment is final until propose_commitment approves it.",
  "Escalate on identity uncertainty, contradictions, refusal, or anything outside the mandate.",
  "A written recap is required before any commitment becomes effective.",
  "Do not invent recording IDs or audio offsets; if authoritative recording metadata is unavailable, escalate.",
];

/**
 * Derive the agent brief for a call from server state. This is deliberately a
 * pure function: the same inputs must always produce the same instructions and
 * the same call kind, so the tool surface handed to the model is auditable.
 */
export function buildAgentProfile(input: {
  call: Pick<CallRecord, "counterparty">;
  operation: OperationInput | null;
  market: CarrierMarket | null;
  selectedQuote: CarrierQuote | null;
}): AgentCallProfile {
  const { call, operation, market, selectedQuote } = input;

  if (!operation) {
    return {
      kind: "intake",
      instructions: [...BASE_INSTRUCTIONS,
        "This call is not linked to an order. Ask first for the order/reference number and the caller's name and carrier company.",
        "Use identify_operation before discussing prices, schedules, or operational details. Supply null for identifying facts not yet known.",
        "If matching fails, ask only the discriminating question returned by the server, then retry with the additional pickup or destination fact.",
        "After three failed attempts or when the server says shouldEscalate=true, request human escalation. Never guess an order or reveal shipment details before a confident match.",
      ].join("\n"),
    };
  }

  const operationInstructions = [...BASE_INSTRUCTIONS,
    `Objective: ${operation.objective}`,
    `Mandate JSON: ${JSON.stringify(operation.mandate)}`,
  ];

  if (!market) {
    return { kind: "direct", instructions: operationInstructions.join("\n") };
  }

  if (selectedQuote && sameCarrier(call.counterparty, selectedQuote.carrier)) {
    return {
      kind: "carrier_confirmation",
      instructions: [...operationInstructions,
        "This is a final confirmation call for the selected carrier quote.",
        `Selected quote JSON: ${JSON.stringify(selectedQuote.terms)}`,
        "Read back the exact selected price, pickup window, and conditions. If the carrier changes any commercial term, do not accept it; request human escalation.",
        "Only after the carrier explicitly confirms the exact selected terms may you use propose_commitment.",
      ].join("\n"),
    };
  }

  return {
    kind: "carrier_quote",
    instructions: [...operationInstructions,
      `This call belongs to carrier market ${market.id}. Candidate: ${call.counterparty ?? "unknown"}.`,
      "Collect a complete commercial quote. Once price, pickup window, and conditions are stated, call record_carrier_quote with the exact evidence range.",
      "A quote is not a booking. Never promise selection, reveal the budget, or call propose_commitment during quote collection.",
    ].join("\n"),
  };
}
