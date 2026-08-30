import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DashboardProcurementVoiceAdapter } from "@/lib/procurement-voice";
import type { OutboundTelephonyGateway, RecapGateway } from "@/lib/volta/ports";
import { VoltaStore } from "@/lib/volta/store";
import { HUMAN_CALLBACK_CLOSING, VoiceControlService } from "@/lib/volta/voice-control-service";
import { FakeAgentRuntime } from "./fake-agent-runtime";
import { createTestContext } from "./helpers";

const telephony: OutboundTelephonyGateway = {
  async dial() { return { providerCallId: "CA_unused" }; },
  async playMessageAndHangup() {},
};
const recap: RecapGateway = {
  async deliver() { return { deliveryId: "SM_unused" }; },
};

/** A runtime whose SIP REFER fails the way a bad or unreachable target would. */
class RefusingTransferRuntime extends FakeAgentRuntime {
  override async transfer(): Promise<void> {
    throw new Error("SIP refer rejected: 480 Temporarily Unavailable");
  }
}

async function setup(options: { humanEscalationUri?: string; runtime?: FakeAgentRuntime } = {}) {
  const { db, repository, markets } = createTestContext();
  const carriers = [
    repository.createContact({ label: "FedEx", phoneInput: "+12025550100", e164PhoneNumber: "+12025550100" }),
    repository.createContact({ label: "UPS", phoneInput: "+12025550109", e164PhoneNumber: "+12025550109" }),
  ];
  const workspace = markets.createOrder({
    name: "Escalation load", client: "Nextwave", origin: "Manzanillo", destination: "Guadalajara",
    currency: "USD", targetPrice: 700, maximumPrice: 900,
    preferredArrival: "2030-01-10T15:00:00.000Z", mustArriveBy: "2030-01-10T18:00:00.000Z",
    priceWeight: 0.6, speedWeight: 0.4, minimumValidOffers: 2, desiredCarriers: 2,
    conditions: [], carrierIds: carriers.map((carrier) => carrier.id),
  });
  const marketId = workspace.currentMarket!.market.id;
  markets.startMarket(marketId);
  const calls = repository.createOutboundBatch(carriers, "+12025550101", { orderId: workspace.order.id, marketId }).calls;
  const runtime = options.runtime ?? new FakeAgentRuntime();
  const store = new VoltaStore(db);
  const service = new VoiceControlService(
    store, runtime, telephony, recap,
    {
      fromNumber: "+12025550101",
      sipUri: "sip:test@sip.api.openai.com",
      humanEscalationUri: options.humanEscalationUri,
    },
    new DashboardProcurementVoiceAdapter(markets, () => new Date("2030-01-10T03:30:00.000Z")),
  );

  await service.handleOpenAiWebhook({
    type: "realtime.call.incoming",
    data: { call_id: "rtc_escalation", sip_headers: [{ name: "X-Internal-Call-ID", value: calls[0]!.id }] },
  });

  return { service, runtime, db, markets, marketId, workspace, calls, carriers };
}

function eventTypes(db: Database.Database, callId: string): string[] {
  return (db.prepare("SELECT type FROM volta_call_events WHERE call_id = ? ORDER BY occurred_at")
    .all(callId) as Array<{ type: string }>).map((event) => event.type);
}

describe("human escalation", () => {
  it("transfers the live leg when a target is configured", async () => {
    const { runtime, db, calls } = await setup({ humanEscalationUri: "tel:+12025550121" });

    const result = await runtime.invokeTool!("request_human_escalation", {
      reason: "Carrier insists on speaking to a person",
    }) as { ok: boolean; transferred: boolean };

    expect(result).toMatchObject({ ok: true, escalated: true, transferred: true });
    expect(runtime.transfers).toEqual([{ realtimeCallId: "rtc_escalation", targetUri: "tel:+12025550121" }]);
    expect(eventTypes(db, calls[0]!.id)).toContain("escalation.transferred");
  });

  it("promises a callback instead of stranding the carrier when no target is configured", async () => {
    const { runtime, db, calls } = await setup();

    const result = await runtime.invokeTool!("request_human_escalation", {
      reason: "Carrier demands a person",
    }) as { ok: boolean; transferred: boolean; handoff: string; say: string };

    // The escalation itself must never report failure: it was recorded, and the
    // lane is paused, whether or not a live transfer was possible.
    expect(result.ok).toBe(true);
    expect(result.transferred).toBe(false);
    expect(result.handoff).toBe("CALLBACK");
    expect(result.say).toBe(HUMAN_CALLBACK_CLOSING);
    expect(runtime.transfers).toHaveLength(0);

    const events = eventTypes(db, calls[0]!.id);
    expect(events).toContain("escalation.no_transfer_target");
    expect(events).toContain("escalation.callback_promised");
    expect(events).not.toContain("escalation.failed");
  });

  it("falls back to the callback close when the transfer itself fails mid-call", async () => {
    const { runtime, db, calls } = await setup({
      humanEscalationUri: "tel:+12025550121",
      runtime: new RefusingTransferRuntime(),
    });

    const result = await runtime.invokeTool!("request_human_escalation", {
      reason: "Carrier contradicts the shipment facts",
    }) as { ok: boolean; handoff: string };

    expect(result).toMatchObject({ ok: true, escalated: true, transferred: false, handoff: "CALLBACK" });
    const events = eventTypes(db, calls[0]!.id);
    expect(events).toContain("escalation.transfer_failed");
    expect(events).toContain("escalation.callback_promised");
  });

  it("says nothing about the order, the market, or the reason in the callback line", () => {
    expect(HUMAN_CALLBACK_CLOSING).toMatch(/call you back/i);
    expect(HUMAN_CALLBACK_CLOSING).not.toMatch(/order|carrier|price|rate|market|mandate/i);
  });

  it("lets an escalated procurement call end instead of holding the line open", async () => {
    const { runtime, markets, marketId, carriers } = await setup();

    const escalation = await runtime.invokeTool!("request_human_escalation", {
      reason: "Carrier demands a person",
    }) as { marketRevision: number };

    // Before the fix this threw action_not_allowed:HUMAN_REQUIRED, leaving the
    // agent with no legal way to hang up on the carrier it had just escalated.
    const finish = await runtime.invokeTool!("finish_procurement_call", {
      marketRevision: escalation.marketRevision,
      disposition: "HUMAN",
    }) as { ok: boolean; instruction: { action: string } };

    expect(finish).toMatchObject({ ok: true, instruction: { action: "HUMAN_REQUIRED" } });

    // The escalated lane is paused, and the rest of the market keeps running.
    const state = markets.getMarketState(marketId)!;
    expect(state.carriers.find((carrier) => carrier.carrier.id === carriers[0]!.id)?.status).toBe("HUMAN");
    expect(state.phase).toBe("HUMAN_REVIEW");
    expect(state.market.status).not.toBe("CLOSED");
  });

  it("keeps the escalation reason in the market for the humans who take over", async () => {
    const { runtime, markets, marketId, carriers } = await setup();

    await runtime.invokeTool!("request_human_escalation", { reason: "Asked for cash payment off the books" });

    const state = markets.getMarketState(marketId)!;
    const escalated = state.carriers.find((carrier) => carrier.carrier.id === carriers[0]!.id)!;
    expect(escalated.humanReason).toBe("Asked for cash payment off the books");
    expect(escalated.instruction.action).toBe("HUMAN_REQUIRED");
    expect(state.reviewReason).toMatch(/human authority/i);
  });
});
