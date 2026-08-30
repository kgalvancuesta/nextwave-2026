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
      pickupTime: null,
      rawStatement: "August 30th at 5 PM.",
    }, now, { expectedTemporalField: "pickupTime" })).toMatchObject({ pickupTime: "2026-08-30T23:00:00.000Z" });
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

  it("retains valid structured times when authoritative transcript evidence is not independently parseable", () => {
    const now = new Date("2026-08-29T23:40:00.000Z");
    const pickup = normalizeProcurementUpdate({
      pickupTime: "2026-08-30T17:00:00-06:00",
      rawStatement: "model-generated summary that must not replace evidence",
    }, now, {
      expectedTemporalField: "pickupTime",
      authoritativeTranscript: "Five.",
      conversationItemId: "item_pickup_five",
    });

    expect(pickup).toMatchObject({
      pickupTime: "2026-08-30T23:00:00.000Z",
      rawStatement: "Five.",
      conversationItemId: "item_pickup_five",
    });

    const arrival = normalizeProcurementUpdate({
      expectedArrival: "2026-08-31T17:30:00-06:00",
    }, now, {
      expectedTemporalField: "expectedArrival",
      authoritativeTranscript: "Five thirty.",
      conversationItemId: "item_arrival_five_thirty",
    });

    expect(arrival).toMatchObject({
      expectedArrival: "2026-08-31T23:30:00.000Z",
      rawStatement: "Five thirty.",
      conversationItemId: "item_arrival_five_thirty",
    });
  });

  it("rejects invalid structured time candidates without relying on transcript parsing", () => {
    const now = new Date("2026-08-29T23:40:00.000Z");
    const invalid = normalizeProcurementUpdate({
      pickupTime: "not-a-date",
      expectedArrival: "2030-08-31T14:00:00-06:00",
    }, now, { authoritativeTranscript: "Five." });

    expect(invalid.pickupTime).toBeUndefined();
    expect(invalid.expectedArrival).toBeUndefined();

    const reversed = normalizeProcurementUpdate({
      pickupTime: "2026-08-31T17:00:00-06:00",
      expectedArrival: "2026-08-31T16:00:00-06:00",
    }, now, { authoritativeTranscript: "Pickup at five and arrival at four." });

    expect(reversed.pickupTime).toBe("2026-08-31T23:00:00.000Z");
    expect(reversed.expectedArrival).toBeUndefined();

    const conflictsWithStoredPickup = normalizeProcurementUpdate({
      expectedArrival: "2026-08-31T16:00:00-06:00",
    }, now, {
      authoritativeTranscript: "Four PM.",
      currentPickupTime: "2026-08-31T17:00:00-06:00",
    });

    expect(conflictsWithStoredPickup.expectedArrival).toBeUndefined();
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
    const adapter = new DashboardProcurementVoiceAdapter(markets, () => new Date("2030-01-10T03:30:00.000Z"));
    const service = new VoiceControlService(
      new VoltaStore(db), runtime, telephony, recap,
      { fromNumber: "+12025550101", sipUri: "sip:test@sip.api.openai.com", humanEscalationUri: "tel:+12025550121" },
      adapter,
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
    expect(runtime.profile?.instructions).toContain("NEGOTIATE: ask once, plainly");
    expect(runtime.profile?.instructions).toContain("never negotiate or counter on your own — the server compares locked quotes and chooses the best feasible one.");
    expect(runtime.profile?.instructions).toContain("Server action:");
    expect(runtime.profile?.instructions).not.toContain("retained offer exactly as stated");
    expect(runtime.profile?.instructions).not.toContain("get_procurement_instruction");
    expect(runtime.profile?.instructions?.split("\n").length).toBeLessThanOrEqual(9);
    expect(runtime.profile?.instructions).toContain("Voicemail: finish VOICEMAIL");
    expect(runtime.profile?.instructions).toContain("never repeat recorded facts");
    expect(runtime.profile?.instructions).toContain("Normalize clearly stated pickup and arrival times to ISO 8601");
    expect(runtime.profile?.instructions).toContain("America/Mexico_City");
    expect(runtime.profile?.instructions).toContain("never mention recording, persistence, storage, tool, server, JSON, schema, formatting, or timestamp-parsing problems");

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

    const draft = adapter.recordUpdate(call.id, {
      availability: "UNKNOWN",
      price: null,
      currency: null,
      rateAllIn: null,
      pickupTime: null,
      expectedArrival: "2030-01-10T05:00:00-06:00",
      firm: null,
      expiresAt: null,
      accessorials: [],
      carrierConditions: [],
      confirmedRequirements: [],
      rejectedRequirements: [],
      rawStatement: "model summary",
      confidence: 0.98,
      humanRequired: false,
      humanReason: null,
    }, {
      transcript: "Five.",
      itemId: "item_arrival_five",
    }).result as {
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
        expected_arrival: "2030-01-10T11:00:00.000Z",
        confirmed_requirements: ["Tolls included"],
      },
      missing_fields: [],
      instruction: { action: "CONFIRM" },
    });
    expect(markets.getMarketState(marketId)?.carriers.find((carrier) => carrier.carrier.id === carriers[0]!.id)?.latestOffer)
      .toMatchObject({
        expectedArrival: "2030-01-10T11:00:00.000Z",
        firm: false,
        rawStatement: "Five.",
        conversationItemId: "item_arrival_five",
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
    // Locking the quote earns one "can you go lower?" before it is parked.
    expect(result).toMatchObject({ ok: true, comparable: true, instruction: { action: "NEGOTIATE", reason: "ask_for_lower_price" } });

    // A flat "no" carries no commercial facts but is the round's answer: it
    // must reach the market and spend the round instead of being a no-op.
    const declined = await runtime.invokeTool!("record_procurement_update", {
      availability: "UNKNOWN", price: null, currency: null, rateAllIn: null,
      pickupTime: null, expectedArrival: null, firm: null, expiresAt: null,
      accessorials: [], carrierConditions: [], confirmedRequirements: [], rejectedRequirements: [],
      rawStatement: "No, that's our best.", confidence: 1, humanRequired: false, humanReason: null,
    }) as { ok: boolean; market_revision: number; instruction: { action: string } };
    expect(declined).toMatchObject({ ok: true, instruction: { action: "HOLD" } });

    const revisionBeforeHold = declined.market_revision;
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
        expectedArrival: "2030-01-10T11:00:00.000Z",
        firm: true,
        confirmedRequirements: ["Tolls included"],
      });

    // The decline advanced the market, so the finish must cite that revision.
    expect(await runtime.invokeTool!("finish_procurement_call", {
      marketRevision: declined.market_revision,
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
    // Locking the quote earns exactly one "can you go lower?" before award.
    expect(await runtime.invokeTool!("record_procurement_update", {
      ...completeOffer,
      availability: "UNKNOWN", price: null, currency: null, rateAllIn: null,
      pickupTime: null, expectedArrival: null, firm: false,
      confirmedRequirements: [], rawStatement: "Yes.",
    })).toMatchObject({
      instruction: { action: "NEGOTIATE", reason: "ask_for_lower_price" }, terminal: false,
    });
    // A flat "no" carries no commercial facts but still spends the round.
    expect(await runtime.invokeTool!("record_procurement_update", {
      ...completeOffer,
      availability: "UNKNOWN", price: null, currency: null, rateAllIn: null,
      pickupTime: null, expectedArrival: null, firm: false,
      confirmedRequirements: [], rawStatement: "No, 700 is already our best rate.",
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

  it("does not lock a quote when the carrier opens with yes but is asking for time", async () => {
    const { db, repository, markets } = createTestContext();
    const carrier = repository.createContact({ label: "Baja Carrier", phoneInput: "+12025550116", e164PhoneNumber: "+12025550116" });
    const workspace = markets.createOrder({
      name: "Baja4", client: "Nextwave", origin: "Manzanillo", destination: "Monterrey", reference: "BAJA4",
      currency: "USD", targetPrice: 700, maximumPrice: 900,
      preferredPickup: "2030-01-10T14:30:00.000Z", mustPickupBy: "2030-01-10T15:00:00.000Z",
      preferredArrival: "2030-01-11T18:00:00.000Z", mustArriveBy: "2030-01-11T20:00:00.000Z",
      priceWeight: 0.6, speedWeight: 0.4, minimumValidOffers: 1, desiredCarriers: 1,
      conditions: ["Tolls included"], carrierIds: [carrier.id],
    });
    const marketId = workspace.currentMarket!.market.id;
    markets.startMarket(marketId);
    const call = repository.createOutboundBatch([carrier], "+12025550101", { orderId: workspace.order.id, marketId }).calls[0]!;
    repository.attachTwilioSidIfMissing(call.id, "CA_baja4_pause");
    const scripted: Array<{ providerCallId: string; message: string }> = [];
    const pauseTelephony: OutboundTelephonyGateway = {
      async dial() { return { providerCallId: "CA_unused" }; },
      async playMessageAndHangup(providerCallId, message) { scripted.push({ providerCallId, message }); },
    };
    const runtime = new FakeAgentRuntime();
    const service = new VoiceControlService(
      new VoltaStore(db), runtime, pauseTelephony, recap,
      { fromNumber: "+12025550101", sipUri: "sip:test@sip.api.openai.com", humanEscalationUri: "tel:+12025550121" },
      new DashboardProcurementVoiceAdapter(markets, () => new Date("2030-01-10T13:00:00.000Z")),
    );
    await service.handleOpenAiWebhook({
      type: "realtime.call.incoming",
      data: { call_id: "rtc_baja4_pause", sip_headers: [{ name: "X-Internal-Call-ID", value: call.id }] },
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
    // The turn opens with "Yes" but agrees to nothing: it must stay a no-op and
    // leave the quote awaiting the recap instead of awarding on a stalling turn.
    expect(await runtime.invokeTool!("record_procurement_update", {
      ...completeOffer,
      availability: "UNKNOWN", price: null, currency: null, rateAllIn: null,
      pickupTime: null, expectedArrival: null, firm: false,
      confirmedRequirements: [], rawStatement: "Yes, let me check with my dispatcher.",
    })).toMatchObject({
      ok: true, no_change: true, pause_requested: true, instruction: { action: "CONFIRM" },
    });
    expect(scripted).toHaveLength(0);
    expect(markets.getMarketState(marketId)?.carriers[0]?.latestOffer?.firm).toBe(false);
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
    expect(adapter.getProfile(inbound.id)?.instructions).toContain("I found order AMEND-1. Are you calling to make a change to this commitment?");
    expect(adapter.getProfile(inbound.id)?.instructions).not.toContain("calling on behalf of Nextwave");
    expect(adapter.proposeAmendment(inbound.id, {
      price: 1_470, currency: "USD", pickupTime: "in 40 minutes", negotiationComplete: false,
    }).result).toMatchObject({ action: "ACCEPT", commitment_updated: true });
  });

  it("waits for the stated reference before routing a known inbound carrier", async () => {
    const { db, repository, markets } = createTestContext();
    const carrier = repository.createContact({
      label: "MexPost", phoneInput: "+525500000008", e164PhoneNumber: "+525500000008",
    });
    const open = markets.createOrder({
      name: "Open procurement", client: "Nextwave", origin: "Manzanillo", destination: "Monterrey", reference: "1117",
      currency: "MXN", targetPrice: 5_000, maximumPrice: 6_000,
      priceWeight: 1, speedWeight: 0, minimumValidOffers: 1, desiredCarriers: 1,
      conditions: [], carrierIds: [carrier.id],
    });
    markets.startMarket(open.currentMarket!.market.id);
    const committed = markets.createOrder({
      name: "Committed order", client: "Nextwave", origin: "Manzanillo", destination: "Guadalajara", reference: "1114",
      currency: "MXN", targetPrice: 5_000, maximumPrice: 6_000,
      priceWeight: 1, speedWeight: 0, minimumValidOffers: 1, desiredCarriers: 1,
      conditions: [], carrierIds: [carrier.id],
    });
    const offer = markets.recordOffer(committed.currentMarket!.market.id, {
      carrierId: carrier.id, price: 5_000, currency: "MXN", isFinalOffer: true,
    }).bestOffer!;
    markets.commitOffer(offer.id);
    const runtime = new FakeAgentRuntime();
    const service = new VoiceControlService(
      new VoltaStore(db), runtime, telephony, recap,
      { fromNumber: "+12025550101", sipUri: "sip:test@sip.api.openai.com", humanEscalationUri: undefined },
      new DashboardProcurementVoiceAdapter(markets),
    );

    const webhook = await service.handleOpenAiWebhook({
      type: "realtime.call.incoming",
      data: { call_id: "rtc_explicit_reference", sip_headers: [{ name: "From", value: carrier.e164PhoneNumber }] },
    });
    expect(runtime.profile?.kind).toBe("intake");
    expect(repository.getCall(webhook.callId!)).toMatchObject({ orderId: null, marketId: null });

    expect(await runtime.invokeTool!("identify_operation", {
      external_reference: "one one one four",
      carrier_name: null,
      caller_name: null,
      origin: null,
      destination: null,
    })).toMatchObject({ ok: true, procurement_market_attached: true });
    expect(runtime.rebriefs).toEqual(["amendment"]);
    expect(runtime.profile?.instructions).toContain("I found order 1114. Are you calling to make a change to this commitment?");
    expect(runtime.profile?.instructions).not.toContain("Can your company meet these requirements?");
    expect(repository.getCall(webhook.callId!)).toMatchObject({
      orderId: committed.order.id,
      marketId: committed.currentMarket!.market.id,
      carrierId: carrier.id,
    });
  });

  it("starts outbound recovery calls when the committed carrier becomes unavailable", async () => {
    const { repository, markets } = createTestContext();
    const carriers = [
      repository.createContact({ label: "Booked", phoneInput: "+12025550115", e164PhoneNumber: "+12025550115" }),
      repository.createContact({ label: "Alternate", phoneInput: "+12025550116", e164PhoneNumber: "+12025550116" }),
    ];
    const created = markets.createOrder({
      name: "Recovery load", client: "Nextwave", origin: "Dallas", destination: "Phoenix", reference: "REC-1",
      currency: "USD", targetPrice: 1_400, maximumPrice: 1_500,
      priceWeight: 1, speedWeight: 0, minimumValidOffers: 1, desiredCarriers: 2,
      conditions: [], carrierIds: carriers.map((carrier) => carrier.id),
    });
    const offer = markets.recordOffer(created.currentMarket!.market.id, {
      carrierId: carriers[0]!.id, price: 1_450, isFinalOffer: true,
    }).bestOffer!;
    markets.recordOffer(created.currentMarket!.market.id, {
      carrierId: carriers[1]!.id, price: 1_475, isFinalOffer: true,
    });
    markets.commitOffer(offer.id);
    const inbound = repository.upsertInboundCall({
      twilioCallSid: "CA_recovery_voice", fromNumber: carriers[0]!.e164PhoneNumber,
      toNumber: "+12025550101", contactId: carriers[0]!.id, status: "IN_PROGRESS", rawPayload: {},
    });
    markets.attachInboundCallToMarket(inbound.id, "REC-1");
    const launched: Array<{ marketId: string; carrierIds: string[] }> = [];
    const adapter = new DashboardProcurementVoiceAdapter(markets, () => new Date("2030-01-10T13:00:00.000Z"), {
      async startMarket(marketId, _orderId, carrierIds) { launched.push({ marketId, carrierIds }); },
      async notifyCarrier() {},
    });

    const outcome = adapter.proposeAmendment(inbound.id, {
      availability: "UNAVAILABLE", negotiationComplete: false,
    });
    expect(outcome.followUps).toEqual([{
      type: "START_RECOVERY_CALLS",
      marketId: (outcome.result as { recovery_market_id: string }).recovery_market_id,
    }]);
    await adapter.runFollowUps(outcome.followUps ?? []);

    expect(launched).toEqual([{
      marketId: (outcome.result as { recovery_market_id: string }).recovery_market_id,
      carrierIds: [carriers[1]!.id],
    }]);
    expect(markets.getMarket((outcome.result as { recovery_market_id: string }).recovery_market_id)?.status).toBe("CALLING");
  });

  it("matches DHL with a visible pause when no valid retained carrier remains", async () => {
    const { repository, markets } = createTestContext();
    const booked = repository.createContact({ label: "Booked", phoneInput: "+12025550117", e164PhoneNumber: "+12025550117" });
    const dhl = repository.createContact({ label: "DHL", phoneInput: "+12025550118", e164PhoneNumber: "+12025550118" });
    const outsideMandate = repository.createContact({ label: "Outside mandate", phoneInput: "+12025550119", e164PhoneNumber: "+12025550119" });
    const created = markets.createOrder({
      name: "DHL recovery load", client: "Nextwave", origin: "Dallas", destination: "Phoenix", reference: "REC-DHL",
      currency: "USD", targetPrice: 1_400, maximumPrice: 1_500,
      priceWeight: 1, speedWeight: 0, minimumValidOffers: 1, desiredCarriers: 2,
      conditions: [], carrierIds: [booked.id, outsideMandate.id],
    });
    const offer = markets.recordOffer(created.currentMarket!.market.id, {
      carrierId: booked.id, price: 1_450, isFinalOffer: true,
    }).bestOffer!;
    markets.recordOffer(created.currentMarket!.market.id, {
      carrierId: outsideMandate.id, price: 1_650, isFinalOffer: true,
    });
    markets.commitOffer(offer.id);
    const inbound = repository.upsertInboundCall({
      twilioCallSid: "CA_dhl_recovery_voice", fromNumber: booked.e164PhoneNumber,
      toNumber: "+12025550101", contactId: booked.id, status: "IN_PROGRESS", rawPayload: {},
    });
    markets.attachInboundCallToMarket(inbound.id, "REC-DHL");
    const sequence: string[] = [];
    const adapter = new DashboardProcurementVoiceAdapter(markets, () => new Date("2030-01-10T13:00:00.000Z"), {
      async startMarket(_marketId, _orderId, carrierIds) { sequence.push(`call:${carrierIds.join(",")}`); },
      async notifyCarrier() {},
    }, async () => { sequence.push("matching"); });

    const outcome = adapter.proposeAmendment(inbound.id, {
      availability: "UNAVAILABLE", negotiationComplete: false,
    });
    const recoveryMarketId = (outcome.result as { recovery_market_id: string }).recovery_market_id;
    const workspace = markets.getOrder(created.order.id)!;
    expect(workspace.currentMarket?.carriers.map((carrier) => carrier.carrier.id)).toEqual([dhl.id]);
    expect(workspace.events.find((event) => event.eventType === "RECOVERY_MARKET_CREATED")?.detail)
      .toBe("Matching with best alternative carriers with similar orders. Calling DHL.");

    await adapter.runFollowUps(outcome.followUps ?? []);

    expect(sequence).toEqual(["matching", `call:${dhl.id}`]);
    expect(markets.getMarket(recoveryMarketId)?.status).toBe("CALLING");
  });

  it("opens an amendment callback as an inbound change request without replaying procurement", () => {
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
    expect(instructions).toContain("I found order 1111. Are you calling to make a change to this commitment?");
    expect(instructions).toContain("Do not first ask them to reconfirm");
    expect(instructions).not.toContain("Can your company meet these requirements?");
    expect(instructions).not.toContain("calling on behalf of Nextwave");
    expect(instructions).not.toContain("2026-08-30T20:00:00.000Z");
    expect(instructions).not.toContain("8 PM UTC");
  });
});
