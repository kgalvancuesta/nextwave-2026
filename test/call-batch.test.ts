import { describe, expect, it } from "vitest";
import { initiateOutboundBatch } from "@/lib/call-service";
import type { CreateCallInput, TelephonyProvider } from "@/lib/telephony";
import { createTestRepository } from "./helpers";

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
  });
});
