import { tool, type RunContext } from "@openai/agents";
import type { RealtimeContextData } from "@openai/agents-realtime";
import { z } from "zod";
import type { VoltaAgentContext, VoltaCallKind } from "./agent-context";

type ToolContext = RealtimeContextData<VoltaAgentContext>;

/**
 * Tool arguments are declared once, in zod, and the Agents SDK derives the
 * strict JSON schema the Realtime model sees. Optional commercial fields are
 * nullable rather than absent because strict schemas require every key; the
 * nulls are stripped before the deterministic layer re-validates the payload.
 */
const rateArgs = z.object({
  amount: z.number().describe("Numeric amount exactly as quoted, no thousands separators."),
  currency: z.string().describe("ISO 4217 code, for example MXN or USD."),
});

const pickupWindowArgs = z.object({
  start: z.string().describe("ISO 8601 timestamp for the earliest agreed pickup."),
  end: z.string().describe("ISO 8601 timestamp for the latest agreed pickup."),
});

const audioEvidenceArgs = z.object({
  conversationItemId: z.string(),
  recordingId: z.string(),
  startMs: z.number().int(),
  endMs: z.number().int(),
}).describe("Exact range in the telephony recording that proves what was said. Never invent it.");

const commercialTermsArgs = {
  summary: z.string(),
  rate: rateArgs,
  pickupWindow: pickupWindowArgs,
  accessorials: z.array(z.string()),
  terms: z.array(z.string()),
  detentionMinutes: z.number().int().nullable(),
  audioEvidence: audioEvidenceArgs,
};

const identifyOperationArgs = z.object({
  external_reference: z.string(),
  carrier_name: z.string().nullable(),
  caller_name: z.string().nullable(),
  origin: z.string().nullable(),
  destination: z.string().nullable(),
});

const briefItemArgs = z.object({
  category: z.string(),
  detail: z.string(),
  conversation_item_id: z.string(),
});

const carrierQuoteArgs = z.object(commercialTermsArgs);

const commitmentArgs = z.object({
  counterparty: z.string(),
  ...commercialTermsArgs,
  recapTarget: z.object({
    channel: z.enum(["sms", "email"]),
    address: z.string(),
  }),
});

const escalationArgs = z.object({ reason: z.string() });

const procurementUpdateArgs = z.object({
  availability: z.enum(["UNKNOWN", "AVAILABLE", "UNAVAILABLE"]),
  price: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  rateAllIn: z.boolean().nullable(),
  pickupTime: z.string().nullable().describe("When the truck can pick up the cargo. Pass ISO 8601 when explicitly known; otherwise pass the carrier's exact phrase verbatim, such as 'tomorrow at 8 AM' or 'in 2 hours'. Never put destination arrival here."),
  expectedArrival: z.string().nullable().describe("When the cargo will reach the destination. Pass ISO 8601 when explicitly known; otherwise pass the carrier's exact phrase verbatim, such as 'August 30th at 5 PM' or 'by two days'. Never put pickup time here or convert a clock time to a duration."),
  firm: z.boolean().nullable(),
  expiresAt: z.string().nullable().describe("ISO 8601 when known; otherwise the carrier's exact relative phrase."),
  accessorials: z.array(z.string()),
  carrierConditions: z.array(z.string()),
  confirmedRequirements: z.array(z.string()),
  rejectedRequirements: z.array(z.string()),
  rawStatement: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  humanRequired: z.boolean(),
  humanReason: z.string().nullable(),
  conversationItemId: z.string().nullable()
    .describe("The id of the conversation item where the carrier said this. Never invent it; pass null if unknown."),
});

const procurementInstructionArgs = z.object({});
const amendmentArgs = z.object({
  price: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  pickupTime: z.string().nullable(),
  expectedArrival: z.string().nullable(),
  unsupportedChange: z.string().nullable(),
  negotiationComplete: z.boolean(),
  rawStatement: z.string().nullable(),
});
const finishProcurementArgs = z.object({
  marketRevision: z.number().int().nonnegative(),
  disposition: z.enum(["RELEASE", "COMPLETE"]),
});

const identifyOperation = tool<typeof identifyOperationArgs, ToolContext, string>({
  name: "identify_operation",
  description: "Attempt to match an inbound caller to an order using the reference, caller/carrier identity, and any route facts collected. Supply null for unknown evidence and follow the server's suggested next question.",
  parameters: identifyOperationArgs,
  execute: (input, runContext) => invoke(runContext, "identify_operation", input),
  errorFunction: toolFailure,
});

const recordBriefItem = tool<typeof briefItemArgs, ToolContext, string>({
  name: "record_brief_item",
  description: "Record a relevant fact, quote, objection, identity claim, condition, or action in the call brief.",
  parameters: briefItemArgs,
  execute: (input, runContext) => invoke(runContext, "record_brief_item", input),
  errorFunction: toolFailure,
});

const recordCarrierQuote = tool<typeof carrierQuoteArgs, ToolContext, string>({
  name: "record_carrier_quote",
  description: "Record an exact carrier quote during a market call. This never books the carrier; the server compares it against the mandate and the other quotes.",
  parameters: carrierQuoteArgs,
  execute: (input, runContext) => invoke(runContext, "record_carrier_quote", withoutNulls(input)),
  errorFunction: toolFailure,
});

const proposeCommitment = tool<typeof commitmentArgs, ToolContext, string>({
  name: "propose_commitment",
  description: "Submit a verbally agreed commitment for deterministic mandate validation. Never claim it is final until this tool approves it.",
  parameters: commitmentArgs,
  execute: (input, runContext) => invoke(runContext, "propose_commitment", withoutNulls(input)),
  errorFunction: toolFailure,
});

const requestHumanEscalation = tool<typeof escalationArgs, ToolContext, string>({
  name: "request_human_escalation",
  description: "Transfer the live call to a human when identity is uncertain, facts conflict, or a request exceeds the mandate.",
  parameters: escalationArgs,
  execute: (input, runContext) => invoke(runContext, "request_human_escalation", input),
  errorFunction: toolFailure,
});

const recordProcurementUpdate = tool<typeof procurementUpdateArgs, ToolContext, string>({
  name: "record_procurement_update",
  description: "Persist every useful availability, all-in price, arrival, requirement confirmation, or changed term immediately. Supply every key; use null or [] for facts the carrier has not stated. Relative times are accepted verbatim and normalized by the server.",
  parameters: procurementUpdateArgs,
  execute: (input, runContext) => invoke(runContext, "record_procurement_update", procurementPatch(input)),
  errorFunction: procurementToolFailure,
});

const getProcurementInstruction = tool<typeof procurementInstructionArgs, ToolContext, string>({
  name: "get_procurement_instruction",
  description: "Reload the current market-wide evaluator instruction immediately before any counter, release, or conclusion.",
  parameters: procurementInstructionArgs,
  execute: (input, runContext) => invoke(runContext, "get_procurement_instruction", input),
  errorFunction: procurementToolFailure,
});

const proposeProcurementAmendment = tool<typeof amendmentArgs, ToolContext, string>({
  name: "propose_procurement_amendment",
  description: "Submit a booked carrier's proposed price or pickup/delivery-time amendment for deterministic evaluation. This does not mutate the commitment unless the server returns ACCEPT.",
  parameters: amendmentArgs,
  execute: (input, runContext) => invoke(runContext, "propose_procurement_amendment", withoutNulls(input)),
  errorFunction: procurementToolFailure,
});

const finishProcurementCall = tool<typeof finishProcurementArgs, ToolContext, string>({
  name: "finish_procurement_call",
  description: "After saying goodbye, end a released or completed procurement call. The server rejects stale market revisions.",
  parameters: finishProcurementArgs,
  execute: (input, runContext) => invoke(runContext, "finish_procurement_call", input),
  errorFunction: procurementToolFailure,
});

/**
 * The tool surface is the real policy boundary, not the prompt. A quote call
 * cannot reach propose_commitment at all, and an unidentified inbound call
 * cannot reach any commercial tool, regardless of what the model is told or
 * what the counterparty tries to talk it into.
 */
export function toolsForKind(kind: VoltaCallKind) {
  switch (kind) {
    case "intake":
      return [identifyOperation, recordBriefItem, requestHumanEscalation];
    case "carrier_quote":
      return [recordBriefItem, recordCarrierQuote, requestHumanEscalation];
    case "procurement":
      return [recordBriefItem, recordProcurementUpdate, getProcurementInstruction, finishProcurementCall, requestHumanEscalation];
    case "amendment":
      return [recordBriefItem, proposeProcurementAmendment, requestHumanEscalation];
    case "carrier_confirmation":
      return [recordBriefItem, proposeCommitment, requestHumanEscalation];
    case "direct":
      return [recordBriefItem, proposeCommitment, requestHumanEscalation];
  }
}

async function invoke(runContext: RunContext<ToolContext> | undefined, name: string, args: unknown): Promise<string> {
  const context = runContext?.context;
  if (!context) throw new Error("agent tool invoked without a Volta call context");
  return JSON.stringify(await context.invokeTool(name, args));
}

/**
 * A rejected tool call is a normal negotiation outcome, not a crash: the model
 * gets a structured refusal it can act on instead of an opaque error string.
 */
function toolFailure(_runContext: RunContext<ToolContext>, error: unknown): string {
  return JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    escalate: true,
  });
}

function procurementToolFailure(_runContext: RunContext<ToolContext>, error: unknown): string {
  return JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    retry: true,
    escalate: false,
    instruction: "Retry the failed procurement tool once. For record_procurement_update, supply every key and use null or [] for unknown values. A payload, date-format, or stale-revision error is not a reason to request human escalation.",
  });
}

function withoutNulls<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null));
}

function procurementPatch(value: z.infer<typeof procurementUpdateArgs>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => {
    if (entry === null) return false;
    if (Array.isArray(entry) && entry.length === 0) return false;
    if (key === "availability" && entry === "UNKNOWN") return false;
    if (key === "humanRequired" && entry === false) return false;
    return true;
  }));
}
