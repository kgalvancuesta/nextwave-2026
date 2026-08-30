import { describe, expect, it } from "vitest";
import { handleStatusCallback, initiateOutboundBatch } from "@/lib/call-service";
import type { CreateCallInput, TelephonyProvider } from "@/lib/telephony";
import { createTestContext, createTestRepository } from "./helpers";

describe("three-call batches", () => {
  it("requests all calls concurrently and isolates one failure", async () => {
    const repository = createTestRepository();
    const contacts = [
      repository.createContact({ label: "A", phoneInput: "+12025550100", e164PhoneNumber: "+12025550100" }),
      repository.createContact({ label: "B", phoneInput: "+12025550109", e164PhoneNumber: "+12025550109" }),
      repository.createContact({ label: "C", phoneInput: "+12025550110", e164PhoneNumber: "+12025550110" }),
    ];
    const requested: CreateCallInput[] = [];
    let release!: () => void;
    const allRequested = new Promise<void>((resolve) => { release = resolve; });
    const provider: TelephonyProvider = {
      async createCall(input) {
        requested.push(input);
        if (requested.length === 3) release();
        await allRequested;
        if (input.to.endsWith("672")) throw Object.assign(new Error("recipient not verified"), { code: 21608 });
        return { callSid: `CA_${input.to.slice(-3)}` };
      },
      async startRecording() { return { recordingSid: "RE_unused" }; },
      async playMessageAndHangup() {},
    };

    const result = await initiateOutboundBatch({
      contactIds: contacts.map((contact) => contact.id),
      fromNumber: "+12025550101",
      repository,
      provider,
    });

    expect(requested).toHaveLength(3);
    expect(result.calls.every((call) => call.batchId === result.batchId)).toBe(true);
    expect(result.calls.filter((call) => call.status === "INITIATED")).toHaveLength(2);
    expect(result.calls.filter((call) => call.status === "FAILED")).toHaveLength(1);
    expect(result.calls.find((call) => call.status === "FAILED")?.errorCode).toBe("21608");
    expect(result.calls.map((call) => call.contactLabel)).toEqual(["A", "B", "C"]);
  });

  it("associates market calls with their order, market, and carrier", async () => {
    const { repository, markets } = createTestContext();
    const contact = repository.createContact({ label: "Rivera", phoneInput: "+12025550100", e164PhoneNumber: "+12025550100" });
    const workspace = markets.createOrder({
      name: "Order 17", client: "Textiles", origin: "Manzanillo", destination: "Guadalajara", currency: "MXN",
      targetPrice: 8_000, maximumPrice: 9_000, priceWeight: 0.7, speedWeight: 0.3,
      minimumValidOffers: 1, desiredCarriers: 1, conditions: [], carrierIds: [contact.id],
    });
    const marketId = workspace.currentMarket!.market.id;
    markets.startMarket(marketId);
    const provider: TelephonyProvider = {
      async createCall() { return { callSid: "CA_market_1" }; },
      async startRecording() { return { recordingSid: "RE_unused" }; },
      async playMessageAndHangup() {},
    };

    const result = await initiateOutboundBatch({
      contactIds: [contact.id],
      fromNumber: "+12025550101",
      repository,
      provider,
      context: { orderId: workspace.order.id, marketId },
    });

    expect(result.calls[0]).toMatchObject({
      orderId: workspace.order.id,
      marketId,
      carrierId: contact.id,
      contactId: contact.id,
    });
    expect(markets.getMarketState(marketId)?.progress.callsStarted).toBe(1);
    handleStatusCallback({ params: { CallSid: "CA_market_1", CallStatus: "in-progress" }, repository });
    handleStatusCallback({ params: { CallSid: "CA_market_1", CallStatus: "completed", CallDuration: "10" }, repository });
    const completedWorkspace = markets.getOrder(workspace.order.id)!;
    expect(completedWorkspace.currentMarket?.market.status).toBe("OPEN");
    expect(completedWorkspace.events.some((event) => event.eventType === "CALL_ANSWERED")).toBe(true);
  });
});
