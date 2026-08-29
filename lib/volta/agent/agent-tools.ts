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

const identifyOperationArgs = z.object({ external_reference: z.string() });

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

const identifyOperation = tool<typeof identifyOperationArgs, ToolContext, string>({
  name: "identify_operation",
  description: "Attach an unassigned inbound call to an operation after the caller provides its reference.",
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

function withoutNulls<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null));
}
