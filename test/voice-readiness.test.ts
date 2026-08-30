import { describe, expect, it } from "vitest";
import { evaluateVoiceEndpointConfig } from "@/lib/voice-readiness";

describe("evaluateVoiceEndpointConfig", () => {
  it("rejects an ephemeral Cloudflare hostname before any carrier is dialed", () => {
    const checks = evaluateVoiceEndpointConfig({
      publicBaseUrl: "https://random-words.trycloudflare.com",
      openAiWebhookUrl: "https://random-words.trycloudflare.com/api/webhooks/openai",
      sipUri: "sip:proj_test@sip.api.openai.com;transport=tls",
      projectId: "proj_test",
    });

    expect(checks.find((check) => check.id === "stable_public_origin")).toMatchObject({ ok: false });
  });

  it("rejects a stale OpenAI webhook target", () => {
    const checks = evaluateVoiceEndpointConfig({
      publicBaseUrl: "https://marketline.example.com",
      openAiWebhookUrl: "https://old.example.com/api/webhooks/openai",
      sipUri: "sip:proj_test@sip.api.openai.com;transport=tls",
      projectId: "proj_test",
    });

    expect(checks.find((check) => check.id === "openai_webhook_target")).toMatchObject({ ok: false });
  });

  it("accepts a stable, internally consistent voice endpoint configuration", () => {
    const checks = evaluateVoiceEndpointConfig({
      publicBaseUrl: "https://marketline.example.com",
      openAiWebhookUrl: "https://marketline.example.com/api/webhooks/openai",
      sipUri: "sip:proj_test@sip.api.openai.com;transport=tls",
      projectId: "proj_test",
    });

    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "stable_public_origin", ok: true }),
      expect.objectContaining({ id: "openai_webhook_target", ok: true }),
      expect.objectContaining({ id: "sip_project", ok: true }),
    ]));
  });

  it("rejects a SIP endpoint for a different OpenAI project", () => {
    const checks = evaluateVoiceEndpointConfig({
      publicBaseUrl: "https://marketline.example.com",
      openAiWebhookUrl: "https://marketline.example.com/api/webhooks/openai",
      sipUri: "sip:proj_other@sip.api.openai.com;transport=tls",
      projectId: "proj_test",
    });

    expect(checks.find((check) => check.id === "sip_project")).toMatchObject({ ok: false });
  });
});
