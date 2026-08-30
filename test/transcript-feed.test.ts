import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "@/db/schema";
import { MarketlineRepository } from "@/lib/repository";
import { VoltaStore } from "@/lib/volta/store";

describe("call transcript feed", () => {
  it("combines caller and agent audit events and removes duplicate assistant finals", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
    const store = new VoltaStore(db);
    const repository = new MarketlineRepository(db);
    const call = store.createCall({
      operationId: null,
      direction: "inbound",
      counterparty: "+12025550131",
      fromNumber: "+12025550131",
      toNumber: "+12025550132",
      status: "active",
      providerCallId: null,
      realtimeCallId: "rtc_test",
    });

    store.appendEvent(call.id, "transcript.turn", { itemId: "item_user", transcript: "Hello there" });
    store.appendEvent(call.id, "agent.turn_completed", { transcript: "How can I help?" });
    store.appendEvent(call.id, "transcript.assistant", {
      itemId: "item_agent",
      responseId: "resp_agent",
      transcript: "How can I help?",
    });

    expect(repository.listTranscriptTurns()).toEqual([
      expect.objectContaining({ callId: call.id, speaker: "CALLER", text: "Hello there", itemId: "item_user" }),
      expect.objectContaining({
        callId: call.id,
        speaker: "AGENT",
        text: "How can I help?",
        itemId: "item_agent",
        responseId: "resp_agent",
      }),
    ]);
    db.close();
  });
});
