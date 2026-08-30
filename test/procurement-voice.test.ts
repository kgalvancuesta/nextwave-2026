import { describe, expect, it } from "vitest";
import {
  buildAwardClosingMessage,
  buildOrderConfirmationMessage,
  DashboardProcurementVoiceAdapter,
  normalizeProcurementTimestamp,
  normalizeProcurementUpdate,
} from "@/lib/procurement-voice";
import type { OutboundTelephonyGateway, RecapGateway } from "@/lib/volta/ports";
import { VoltaStore } from "@/lib/volta/store";
import { VoiceControlService } from "@/lib/volta/voice-control-service";
import { FakeAgentRuntime } from "./fake-agent-runtime";
import { createTestContext } from "./helpers";

const telephony: OutboundTelephonyGateway = {
  async dial() { return { providerCallId: "CA_unused" }; },
  async playMessageAndHangup() {},
};
const recap: RecapGateway = {
  async deliver() { return { deliveryId: "SM_unused" }; },
};

describe("dashboard procurement voice bridge", () => {
  it("uses an agent-led order recap and a fixed award closing", () => {
    const recap = buildOrderConfirmationMessage({
      reference: "BAJA3",
      origin: "Manzanillo",
      destination: "Monterrey",
      preferredPickup: "2030-01-10T14:30:00.000Z",
      mustPickupBy: "2030-01-10T15:00:00.000Z",
      preferredArrival: null,
      mustArriveBy: "2030-01-11T18:00:00.000Z",
      conditions: ["Tolls included"],
    });
    expect(recap).toContain("order BAJA3, from Manzanillo to Monterrey");
    expect(recap).toContain("The required conditions are Tolls included");
    expect(recap).toMatch(/Can your company meet these requirements\?$/);
    expect(recap).not.toMatch(/Is that correct\?$/);

    const closing = buildAwardClosingMessage({
      reference: "BAJA3",
      origin: "Manzanillo",
      destination: "Monterrey",
      price: 700,
      currency: "USD",
      pickupTime: "2030-01-10T14:30:00.000Z",
      expectedArrival: "2030-01-11T18:00:00.000Z",
    });
    expect(closing).toContain("Your offer has been awarded for order BAJA3");
    expect(closing).toContain("$700.00");
    expect(closing).toContain("We'll send the confirmation email shortly");
    expect(closing).not.toContain("authority");
  });

  it("normalizes number-word timing and preserves an explicit all-in statement", () => {
    const now = new Date("2030-01-10T03:30:00.000Z");
    expect(normalizeProcurementTimestamp("by two days", now)).toBe("2030-01-12T03:30:00.000Z");
    expect(normalizeProcurementTimestamp("it will take two days to get it out", now)).toBe("2030-01-12T03:30:00.000Z");
    expect(normalizeProcurementUpdate({ rawStatement: "Our all-in price is 150 USD" }, now)).toMatchObject({ rateAllIn: true });
    expect(normalizeProcurementUpdate({ expectedArrival: "in 12 hours", rawStatement: "Arrival in 12 hours" }, now, {
      expectedTemporalField: "expectedArrival",
    })).toMatchObject({ expectedArrival: "2030-01-10T15:30:00.000Z" });
  });

  it("normalizes spoken pickup and arrival clocks without asking for reformatted confirmation", () => {
    const now = new Date("2026-08-29T23:40:00.000Z");
    expect(normalizeProcurementTimestamp("tomorrow at 8 AM", now)).toBe("2026-08-30T14:00:00.000Z");
    expect(normalizeProcurementTimestamp("August 30th at 5 PM", now)).toBe("2026-08-30T23:00:00.000Z");
    expect(normalizeProcurementUpdate({
      pickupTime: null,
      rawStatement: "Pickup time stated as tomorrow at 8 AM; firm confirmed.",
    }, now)).toMatchObject({ pickupTime: "2026-08-30T14:00:00.000Z" });
    expect(normalizeProcurementUpdate({
      pickupTime: "in 12 hours",
      rawStatement: "August 30th at 5 PM.",
    }, now)).toMatchObject({ pickupTime: "2026-08-30T23:00:00.000Z" });
    expect(normalizeProcurementUpdate({
      price: 5_000,
      currency: "MXN",
      expectedArrival: null,
      rawStatement: "Our price is 5,000 pesos.",
    }, now, {
      expectedTemporalField: "expectedArrival",
      authoritativeTranscript: "I can do tomorrow at 5:00 PM for 5,000 pesos.",
      conversationItemId: "item_compound_quote",
    })).toMatchObject({
      price: 5_000,
      currency: "MXN",
      expectedArrival: "2026-08-30T23:00:00.000Z",
      rawStatement: "I can do tomorrow at 5:00 PM for 5,000 pesos.",
      conversationItemId: "item_compound_quote",
    });

    expect(normalizeProcurementUpdate({
      availability: "AVAILABLE",
      price: 1_450,
      currency: "USD",
      pickupTime: null,
      expectedArrival: null,
      rawStatement: "Yeah. 1450 all in, pickup tomorrow at eight and delivery around two thirty.",
    }, now)).toMatchObject({
      availability: "AVAILABLE",
      price: 1_450,
      currency: "USD",
      rateAllIn: true,
      pickupTime: "2026-08-30T14:00:00.000Z",
      expectedArrival: "2026-08-30T20:30:00.000Z",
    });

    expect(normalizeProcurementUpdate({
      expectedArrival: null,
      rawStatement: "Probably around five.",
    }, now, { expectedTemporalField: "expectedArrival" })).toMatchObject({
      expectedArrival: "2026-08-30T11:00:00.000Z",
    });

    expect(normalizeProcurementTimestamp("5000", now)).toBeNull();
    const corrupted = normalizeProcurementUpdate({
      price: 5_000,
      currency: "MXN",
      rateAllIn: true,
      expectedArrival: "5000",
      rawStatement: "Our all-in price is 5000.",
      confirmedRequirements: ["Route from Manzana to Platano"],
    }, now, {
      expectedTemporalField: "expectedArrival",
      authoritativeTranscript: "Yeah, my price would be 5,000.",
      conversationItemId: "item_price_only",
      allowedRequirements: [],
    });
    expect(corrupted).toMatchObject({
      price: 5_000,
      rawStatement: "Yeah, my price would be 5,000.",
      conversationItemId: "item_price_only",
      confirmedRequirements: [],
    });
    expect(corrupted.expectedArrival).toBeUndefined();
  });

  it("briefs a dashboard market call as procurement and streams tool facts into the shared market", async () => {
    const { db, repository, markets } = createTestContext();
    const carriers = [
      repository.createContact({ label: "FedEx", phoneInput: "+12025550100", e164PhoneNumber: "+12025550100" }),
      repository.createContact({ label: "UPS", phoneInput: "+12025550109", e164PhoneNumber: "+12025550109" }),
    ];
    const workspace = markets.createOrder({
      name: "Voice load", client: "Nextwave", origin: "Manzanillo", destination: "Guadalajara",
      currency: "USD", targetPrice: 700, maximumPrice: 900,
      preferredArrival: "2030-01-10T15:00:00.000Z", mustArriveBy: "2030-01-10T18:00:00.000Z",
      priceWeight: 0.6, speedWeight: 0.4, minimumValidOffers: 2, desiredCarriers: 2,
      conditions: ["Tolls included"], carrierIds: carriers.map((carrier) => carrier.id),
    });
    const marketId = workspace.currentMarket!.market.id;
    markets.startMarket(marketId);
    const call = repository.createOutboundBatch(carriers, "+12025550101", { orderId: workspace.order.id, marketId }).calls[0]!;
    repository.attachTwilioSidIfMissing(call.id, "CA_procurement");
    const runtime = new FakeAgentRuntime();
    const service = new VoiceControlService(
      new VoltaStore(db), runtime, telephony, recap,
      { fromNumber: "+12025550101", sipUri: "sip:test@sip.api.openai.com", humanEscalationUri: "tel:+12025550121" },
      new DashboardProcurementVoiceAdapter(markets, () => new Date("2030-01-10T03:30:00.000Z")),
    );

    await service.handleOpenAiWebhook({
      type: "realtime.call.incoming",
      data: { call_id: "rtc_procurement", sip_headers: [{ name: "X-Internal-Call-ID", value: call.id }] },
    });
    expect(runtime.profile?.kind).toBe("procurement");
    expect(runtime.profile?.instructions).toContain("Can your company meet these requirements?");
    expect(runtime.profile?.instructions).toContain("concise freight procurement agent");
    expect(runtime.profile?.instructions).toContain("What destination arrival time can you commit to, and what is your all-in price in USD?");
    expect(runtime.profile?.instructions).toContain("CONFIRM: recap once");
    expect(runtime.profile?.instructions).toContain("Never negotiate or counter.");
    expect(runtime.profile?.instructions).toContain("The server compares locked quotes and chooses the best feasible one.");
    expect(runtime.profile?.instructions).toContain("Server action:");
    expect(runtime.profile?.instructions).not.toContain("retained offer exactly as stated");
    expect(runtime.profile?.instructions).not.toContain("get_procurement_instruction");
    expect(runtime.profile?.instructions?.split("\n").length).toBeLessThanOrEqual(9);
    expect(runtime.profile?.instructions).toContain("Voicemail: finish VOICEMAIL");
    expect(runtime.profile?.instructions).toContain("never repeat recorded facts");

    const partial = await runtime.invokeTool!("record_procurement_update", {
      availability: "AVAILABLE",
      price: 760,
      currency: "USD",
      rateAllIn: true,
      pickupTime: null,
      expectedArrival: null,
      firm: false,
      expiresAt: null,
      accessorials: [],
      carrierConditions: [],
      confirmedRequirements: ["Tolls included"],
      rejectedRequirements: [],
      rawStatement: "760 all-in",
      confidence: 0.98,
      humanRequired: false,
      humanReason: null,
    }) as { ok: boolean; instruction: { action: string } };
    expect(partial).toMatchObject({ ok: true, comparable: false, instruction: { action: "ASK_MISSING_FIELD" } });

    const draft = await runtime.invokeTool!("record_procurement_update", {
      availability: "UNKNOWN",
      price: null,
      currency: null,
      rateAllIn: null,
      pickupTime: null,
      expectedArrival: "in 12 hours",
      firm: null,
      expiresAt: null,
      accessorials: [],
      carrierConditions: [],
      confirmedRequirements: [],
      rejectedRequirements: [],
      rawStatement: "Arrival in 12 hours",
      confidence: 0.98,
      humanRequired: false,
      humanReason: null,
    }) as {
      ok: boolean;
      instruction: { action: string };
      recorded_values: {
        availability: string;
        price: number | null;
        currency: string | null;
        rate_all_in: boolean | null;
        pickup_time: string | null;
        expected_arrival: string | null;
        confirmed_requirements?: string[];
      };
      missing_fields?: string[];
    };

    expect(draft).toMatchObject({
      ok: true,
      comparable: false,
      recorded_values: {
        availability: "AVAILABLE",
        price: 760,
        currency: "USD",
        rate_all_in: true,
        pickup_time: null,
        expected_arrival: "2030-01-10T15:30:00.000Z",
        confirmed_requirements: ["Tolls included"],
      },
      missing_fields: [],
      instruction: { action: "CONFIRM" },
    });

    const result = await runtime.invokeTool!("record_procurement_update", {
      availability: "UNKNOWN",
      price: null,
      currency: null,
      rateAllIn: null,
      pickupTime: null,
      expectedArrival: null,
      firm: null,
      expiresAt: null,
      accessorials: [],
      carrierConditions: [],
      confirmedRequirements: [],
      rejectedRequirements: [],
      rawStatement: "Yes.",
      confidence: 1,
      humanRequired: false,
      humanReason: null,
    }) as typeof draft;
    expect(result).toMatchObject({ ok: true, comparable: true, instruction: { action: "HOLD" } });

    const revisionBeforeHold = (result as typeof result & { market_revision: number }).market_revision;
    const hold = await runtime.invokeTool!("record_procurement_update", {
      availability: "UNKNOWN", price: null, currency: null, rateAllIn: null,
      pickupTime: null, expectedArrival: null, firm: false, expiresAt: null,
      accessorials: [], carrierConditions: [], confirmedRequirements: [], rejectedRequirements: [],
      rawStatement: "Hold.", confidence: 1, humanRequired: false, humanReason: null,
    }) as { no_change: boolean; market_revision: number };
    expect(hold).toMatchObject({ ok: true, no_change: true, market_revision: revisionBeforeHold });
    expect(markets.getMarketState(marketId)?.carriers.find((carrier) => carrier.carrier.id === carriers[0]!.id)?.latestOffer)
      .toMatchObject({
        availability: "AVAILABLE",
        price: 760,
        currency: "USD",
        rateAllIn: true,
        expectedArrival: "2030-01-10T15:30:00.000Z",
        confirmedRequirements: ["Tolls included"],
      });

    const recorded = result as typeof result & { market_revision: number };
    expect(await runtime.invokeTool!("finish_procurement_call", {
      marketRevision: recorded.market_revision,
      disposition: "QUOTE_RECORDED",
    })).toMatchObject({ ok: true, disposition: "QUOTE_RECORDED", instruction: { action: "HOLD" } });
  });

  it("treats a carrier pause as no-op and does not wake parallel calls for revision-only changes", async () => {
    const { db, repository, markets } = createTestContext();
    const carriers = [
      repository.createContact({ label: "First", phoneInput: "+12025550111", e164PhoneNumber: "+12025550111" }),
      repository.createContact({ label: "Second", phoneInput: "+12025550112", e164PhoneNumber: "+12025550112" }),
    ];
    const workspace = markets.createOrder({
      name: "Parallel voice", client: "Nextwave", origin: "Manzana", destination: "Platano",
      currency: "MXN", targetPrice: 8_000, maximumPrice: 10_000,
      preferredArrival: "2030-01-10T15:00:00.000Z", mustArriveBy: "2030-01-10T18:00:00.000Z",
      priceWeight: 0.9, speedWeight: 0.1, minimumValidOffers: 2, desiredCarriers: 2,
      conditions: [], carrierIds: carriers.map((carrier) => carrier.id),
    });
    const marketId = workspace.currentMarket!.market.id;
    markets.startMarket(marketId);
    const calls = repository.createOutboundBatch(carriers, "+12025550101", {
      orderId: workspace.order.id,
      marketId,
    }).calls;
    const runtime = new FakeAgentRuntime();
    const service = new VoiceControlService(
      new VoltaStore(db), runtime, telephony, recap,
      { fromNumber: "+12025550101", sipUri: "sip:test@sip.api.openai.com", humanEscalationUri: undefined },
      new DashboardProcurementVoiceAdapter(markets, () => new Date("2030-01-10T03:30:00.000Z")),
    );
    for (const [index, call] of calls.entries()) {
      await service.handleOpenAiWebhook({
        type: "realtime.call.incoming",
        data: { call_id: `rtc_parallel_${index}`, sip_headers: [{ name: "X-Internal-Call-ID", value: call.id }] },
      });
    }

    const second = calls[1]!;
    const revisionBeforePause = markets.getMarketState(marketId)!.market.revision;
    runtime.emitCarrierTranscriptFor(second.id, "Let me check with my system.", "item_pause");
    const pause = await runtime.invokeFor(second.id, "record_procurement_update", {
      availability: "UNKNOWN", price: null, currency: null, rateAllIn: null,
      pickupTime: null, expectedArrival: null, firm: null, expiresAt: null,
      accessorials: [], carrierConditions: [], confirmedRequirements: [], rejectedRequirements: [],
      rawStatement: "Carrier is checking.", confidence: null, humanRequired: false, humanReason: null,
      conversationItemId: "invented_item",
    });
    expect(pause).toMatchObject({ ok: true, no_change: true, pause_requested: true });
    expect(markets.getMarketState(marketId)!.market.revision).toBe(revisionBeforePause);
    expect(markets.getMarketState(marketId)!.carriers.find((entry) => entry.carrier.id === carriers[1]!.id)?.latestOffer).toBeNull();

    const first = calls[0]!;
    runtime.emitCarrierTranscriptFor(first.id, "Yes.", "item_yes");
    await runtime.invokeFor(first.id, "record_procurement_update", {
      availability: "AVAILABLE", price: null, currency: null, rateAllIn: null,
      pickupTime: null, expectedArrival: null, firm: null, expiresAt: null,
      accessorials: [], carrierConditions: [], confirmedRequirements: [], rejectedRequirements: [],
      rawStatement: "yes", confidence: 1, humanRequired: false, humanReason: null,
      conversationItemId: "item_yes",
    });
    expect(runtime.responsesRequestedByCall.get(second.id)).toBe(1);
    expect(runtime.injectedByCall.get(second.id) ?? []).toHaveLength(0);
  });

  it("ends voicemail cleanly instead of restarting the procurement opener", async () => {
    const { db, repository, markets } = createTestContext();
    const carrier = repository.createContact({
      label: "Voicemail carrier", phoneInput: "+12025550113", e164PhoneNumber: "+12025550113",
    });
    const workspace = markets.createOrder({
      name: "Voicemail load", client: "Nextwave", origin: "Manzanillo", destination: "Guadalajara",
      currency: "MXN", targetPrice: 5_000, maximumPrice: 7_000,
      preferredArrival: "2030-01-10T15:00:00.000Z", mustArriveBy: "2030-01-10T18:00:00.000Z",
      priceWeight: 0.6, speedWeight: 0.4, minimumValidOffers: 1, desiredCarriers: 1,
      conditions: [], carrierIds: [carrier.id],
    });
    const marketId = workspace.currentMarket!.market.id;
    const started = markets.startMarket(marketId);
    const call = repository.createOutboundBatch([carrier], "+12025550101", {
      orderId: workspace.order.id, marketId,
    }).calls[0]!;
    repository.attachTwilioSidIfMissing(call.id, "CA_voicemail");
    const scripted: Array<{ providerCallId: string; message: string }> = [];
    const voicemailTelephony: OutboundTelephonyGateway = {
      async dial() { return { providerCallId: "CA_unused" }; },
      async playMessageAndHangup(providerCallId, message) { scripted.push({ providerCallId, message }); },
    };
    const runtime = new FakeAgentRuntime();
    const service = new VoiceControlService(
      new VoltaStore(db), runtime, voicemailTelephony, recap,
      { fromNumber: "+12025550101", sipUri: "sip:test@sip.api.openai.com", humanEscalationUri: undefined },
      new DashboardProcurementVoiceAdapter(markets),
    );

    await service.handleOpenAiWebhook({
      type: "realtime.call.incoming",
      data: { call_id: "rtc_voicemail", sip_headers: [{ name: "X-Internal-Call-ID", value: call.id }] },
    });
    expect(await runtime.invokeTool!("finish_procurement_call", {
      marketRevision: started.market.revision,
      disposition: "VOICEMAIL",
    })).toMatchObject({ ok: true, disposition: "VOICEMAIL", scripted_message_dispatched: true });
    expect(scripted).toEqual([{
      providerCallId: "CA_voicemail",
      message: expect.stringContaining("Please call us back when available"),
    }]);
    expect(runtime.sessionsClosed).toBe(1);
  });

  it("locks an explicit quote and replaces the AI with the scripted award closing", async () => {
    const { db, repository, markets } = createTestContext();
    const carrier = repository.createContact({ label: "Baja Carrier", phoneInput: "+12025550115", e164PhoneNumber: "+12025550115" });
    const workspace = markets.createOrder({
      name: "Baja3", client: "Nextwave", origin: "Manzanillo", destination: "Monterrey", reference: "BAJA3",
      currency: "USD", targetPrice: 700, maximumPrice: 900,
      preferredPickup: "2030-01-10T14:30:00.000Z", mustPickupBy: "2030-01-10T15:00:00.000Z",
      preferredArrival: "2030-01-11T18:00:00.000Z", mustArriveBy: "2030-01-11T20:00:00.000Z",
      priceWeight: 0.6, speedWeight: 0.4, minimumValidOffers: 1, desiredCarriers: 1,
      conditions: ["Tolls included"], carrierIds: [carrier.id],
    });
    const marketId = workspace.currentMarket!.market.id;
    markets.startMarket(marketId);
    const call = repository.createOutboundBatch([carrier], "+12025550101", { orderId: workspace.order.id, marketId }).calls[0]!;
    repository.attachTwilioSidIfMissing(call.id, "CA_baja3_award");
    const scripted: Array<{ providerCallId: string; message: string }> = [];
    const awardTelephony: OutboundTelephonyGateway = {
      async dial() { return { providerCallId: "CA_unused" }; },
      async playMessageAndHangup(providerCallId, message) { scripted.push({ providerCallId, message }); },
    };
    const runtime = new FakeAgentRuntime();
    const service = new VoiceControlService(
      new VoltaStore(db), runtime, awardTelephony, recap,
      { fromNumber: "+12025550101", sipUri: "sip:test@sip.api.openai.com", humanEscalationUri: "tel:+12025550121" },
      new DashboardProcurementVoiceAdapter(markets, () => new Date("2030-01-10T13:00:00.000Z")),
    );
    await service.handleOpenAiWebhook({
      type: "realtime.call.incoming",
      data: { call_id: "rtc_baja3_award", sip_headers: [{ name: "X-Internal-Call-ID", value: call.id }] },
    });
    const completeOffer = {
      availability: "AVAILABLE", price: 700, currency: "USD", rateAllIn: true,
      pickupTime: "2030-01-10T14:30:00.000Z", expectedArrival: "2030-01-11T18:00:00.000Z",
      firm: false, expiresAt: null, accessorials: [], carrierConditions: [],
      confirmedRequirements: ["Tolls included"], rejectedRequirements: [],
      rawStatement: "700 dollars all-in, pickup January 10 at 8:30 AM and arrival January 11 at 12 PM. Tolls included.",
      confidence: 0.99, humanRequired: false, humanReason: null,
    };

    expect(await runtime.invokeTool!("record_procurement_update", completeOffer)).toMatchObject({
      instruction: { action: "CONFIRM" }, terminal: false,
    });
    expect(await runtime.invokeTool!("record_procurement_update", {
      ...completeOffer,
      availability: "UNKNOWN", price: null, currency: null, rateAllIn: null,
      pickupTime: null, expectedArrival: null, firm: false,
      confirmedRequirements: [], rawStatement: "Yes.",
    })).toMatchObject({
      instruction: { action: "AWARD" }, terminal: true, scripted_message_dispatched: true,
    });
    expect(scripted).toHaveLength(1);
    expect(scripted[0]).toMatchObject({ providerCallId: "CA_baja3_award" });
    expect(scripted[0]?.message).toContain("Your offer has been awarded for order BAJA3");
    expect(scripted[0]?.message).toContain("We'll send the confirmation email shortly");
    expect(runtime.responsesRequested).toBe(1);
    expect(runtime.sessionsClosed).toBe(1);
  });

  it("re-briefs the booked carrier with the restricted amendment workflow", () => {
    const { repository, markets } = createTestContext();
    const carrier = repository.createContact({ label: "Booked carrier", phoneInput: "+12025550114", e164PhoneNumber: "+12025550114" });
    const created = markets.createOrder({
      name: "Booked load", client: "Nextwave", origin: "Dallas", destination: "Phoenix", reference: "AMEND-1",
      currency: "USD", targetPrice: 1_400, maximumPrice: 1_500,
      preferredPickup: "2030-01-10T14:30:00.000Z", mustPickupBy: "2030-01-10T15:00:00.000Z",
      priceWeight: 1, speedWeight: 0, minimumValidOffers: 1, desiredCarriers: 1,
      conditions: [], carrierIds: [carrier.id],
    });
    const offer = markets.recordOffer(created.currentMarket!.market.id, {
      carrierId: carrier.id, price: 1_450, pickupTime: "2030-01-10T14:30:00.000Z", isFinalOffer: true,
    }).bestOffer!;
    markets.commitOffer(offer.id);
    const inbound = repository.upsertInboundCall({
      twilioCallSid: "CA_amendment_voice", fromNumber: carrier.e164PhoneNumber, toNumber: "+12025550101",
      contactId: carrier.id, status: "IN_PROGRESS", rawPayload: {},
    });
    markets.attachInboundCallToMarket(inbound.id, "AMEND-1");
    const adapter = new DashboardProcurementVoiceAdapter(markets, () => new Date("2030-01-10T13:00:00.000Z"));

    expect(adapter.getProfile(inbound.id)).toMatchObject({ kind: "amendment" });
    expect(adapter.getProfile(inbound.id)?.instructions).toContain("Never say a requested change is accepted");
    expect(adapter.proposeAmendment(inbound.id, {
      price: 1_470, currency: "USD", pickupTime: "in 40 minutes", negotiationComplete: false,
    }).result).toMatchObject({ action: "ACCEPT", commitment_updated: true });
  });

  it("recaps only preformatted dashboard requirements on an amendment callback", () => {
    const { repository, markets } = createTestContext();
    const carrier = repository.createContact({ label: "Booked carrier", phoneInput: "+12025550120", e164PhoneNumber: "+12025550120" });
    const created = markets.createOrder({
      name: "Baja3", client: "Nextwave", origin: "Manzanillo", destination: "Monterrey", reference: "1111",
      currency: "MXN", targetPrice: 5_000, maximumPrice: 10_000,
      preferredArrival: "2026-08-31T23:55:00.000Z", mustArriveBy: "2026-08-31T23:55:00.000Z",
      priceWeight: 1, speedWeight: 0, minimumValidOffers: 1, desiredCarriers: 1,
      conditions: [], carrierIds: [carrier.id],
    });
    const offer = markets.recordOffer(created.currentMarket!.market.id, {
      carrierId: carrier.id, price: 5_000, currency: "MXN",
      expectedArrival: "2026-08-30T20:00:00.000Z", isFinalOffer: true,
    }).bestOffer!;
    markets.commitOffer(offer.id);
    const inbound = repository.upsertInboundCall({
      twilioCallSid: "CA_dashboard_recap", fromNumber: carrier.e164PhoneNumber, toNumber: "+12025550101",
      contactId: carrier.id, status: "IN_PROGRESS", rawPayload: {},
    });
    markets.attachInboundCallToMarket(inbound.id, "1111");

    const instructions = new DashboardProcurementVoiceAdapter(markets).getProfile(inbound.id)?.instructions ?? "";
    expect(instructions).toContain("Preferred destination arrival is August 31 at 5:55 PM CST");
    expect(instructions).toContain("Read verbatim");
    expect(instructions).not.toContain("2026-08-30T20:00:00.000Z");
    expect(instructions).not.toContain("Current commitment");
    expect(instructions).not.toContain("8 PM UTC");
  });
});
