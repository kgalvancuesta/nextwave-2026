import { describe, expect, it } from "vitest";
import { buildCorrelatedSipUri } from "@/lib/volta/sip";

describe("SIP correlation", () => {
  it("issues the call and operation headers on the INVITE", () => {
    const uri = buildCorrelatedSipUri({
      sipUri: "sip:proj_abc@sip.api.openai.com;transport=tls",
      internalCallId: "call_1",
      operationId: "operation_1",
    });

    expect(uri).toContain("X-Internal-Call-ID=call_1");
    expect(uri).toContain("X-Operation-ID=operation_1");
    expect(uri.startsWith("sip:proj_abc@sip.api.openai.com;transport=tls?")).toBe(true);
  });

  it("replaces preconfigured correlation headers without dropping unrelated ones", () => {
    const uri = buildCorrelatedSipUri({
      sipUri: "sip:proj_abc@sip.api.openai.com?X-Internal-Call-ID=spoofed&X-Trace=keep",
      internalCallId: "call_2",
      operationId: "operation_2",
    });

    expect(uri).not.toContain("spoofed");
    expect(uri).toContain("X-Trace=keep");
    expect(uri).toContain("X-Internal-Call-ID=call_2");
  });

  it("omits the operation header while an inbound call is still unidentified", () => {
    const uri = buildCorrelatedSipUri({
      sipUri: "sip:proj_abc@sip.api.openai.com",
      internalCallId: "call_3",
      operationId: null,
    });

    expect(uri).toContain("X-Internal-Call-ID=call_3");
    expect(uri).not.toContain("X-Operation-ID");
  });

  it("refuses a target that is not a SIP URI", () => {
    expect(() => buildCorrelatedSipUri({
      sipUri: "https://sip.api.openai.com",
      internalCallId: "call_4",
      operationId: null,
    })).toThrow(/must start with sip:/);
  });
});
